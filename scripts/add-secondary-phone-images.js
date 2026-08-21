/**
 * Adds a 2nd (and sometimes 3rd) real image to smartphones that currently
 * only have 1, by cross-referencing the same model in the multi-image
 * Amazon-US phone dataset (marawan1234/amazon-product-phones-dataset).
 * Keeps the existing accurate current-gen photo as the primary/thumbnail;
 * appends genuinely real additional photos of the same model as gallery images.
 */
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { parse } from "csv-parse/sync";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Product from "../models/Product.js";

const BUCKET = process.env.S3_BUCKET || "vkart-assets-mumbai";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "ap-south-1";
const s3 = new S3Client({ region: REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
const CSV_PATH = "C:\\Users\\balav\\AppData\\Local\\Temp\\claude\\C--Users-balav-projects-vkart\\8d2147d4-f81f-455b-a08c-414156dd3c48\\scratchpad\\kaggle_check\\phones\\amazon_product_data.csv";

function upgradeAmazonImageUrl(url) {
  const m = url.match(/\/images\/I\/([A-Za-z0-9+_-]+)\.[^/?]*\.(jpg|jpeg|png)/i);
  if (m) return `https://m.media-amazon.com/images/I/${m[1]}._AC_SL1500_.${m[2]}`;
  return url;
}
async function downloadImage(url) {
  const res = await fetch(url.trim(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) throw new Error("too small/likely broken");
  return buf;
}
async function uploadToS3(buffer, key) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: "image/jpeg", ServerSideEncryption: "AES256" }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

// title substring -> Amazon CSV name-match regex
const MATCHES = [
  { titleIncludes: "iPhone 15 (", re: /^iphone 15\b(?!.*(pro|plus))/i },
  { titleIncludes: "iPhone 15 Plus", re: /^iphone 15 plus/i },
  { titleIncludes: "iPhone 14 (", re: /^iphone 14\b(?!.*(pro|plus))/i },
  { titleIncludes: "Galaxy S24 Ultra", re: /galaxy s24 ultra/i },
  { titleIncludes: "Galaxy S23 FE", re: /galaxy s23 fe/i },
  { titleIncludes: "Pixel 9 Pro (", re: /pixel 9 pro\b(?!.*xl)/i },
  { titleIncludes: "Pixel 8a", re: /pixel 8a/i },
  { titleIncludes: "Redmi Note 13 Pro", re: /redmi note 13 pro/i },
  { titleIncludes: "POCO F6", re: /poco f6/i },
  { titleIncludes: "Nothing Phone (2a)", re: /nothing phone.*2a/i },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] Connected");

  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  const BAD_LISTING_RE = /case|cover|screen protector|charger|cable|adapter|holster|skin|sticker|tempered glass|stylus|mount|stand\b/i;

  let updated = 0;
  for (const m of MATCHES) {
    const product = await Product.findOne({ category: "smartphones", title: new RegExp(m.titleIncludes.replace(/[()]/g, "\\$&"), "i") });
    if (!product) { console.log(`DB product not found for: ${m.titleIncludes}`); continue; }

    const candidates = rows.filter((r) => m.re.test(r.name || "") && !BAD_LISTING_RE.test(r.name || "") && r.image_links && r.image_links !== "[]");
    if (!candidates.length) { console.log(`No CSV match for: ${m.titleIncludes}`); continue; }

    const best = candidates.sort((a, b) => (b.image_links.match(/https/g) || []).length - (a.image_links.match(/https/g) || []).length)[0];
    const urls = [...best.image_links.matchAll(/https:\/\/[^\s'"]+/g)].map((x) => x[0]).filter((u) => !u.includes("transparent-pixel")).map(upgradeAmazonImageUrl);

    process.stdout.write(`  ${product.title}: found ${urls.length} candidate images...`);
    const newImages = [];
    for (let i = 0; i < urls.length && newImages.length < 2; i++) {
      try {
        const buf = await downloadImage(urls[i]);
        const key = `product-images/SMARTPHONES-${product._id}-extra${Math.random().toString(36).slice(2, 8)}-${i}.jpg`;
        newImages.push(await uploadToS3(buf, key));
      } catch (e) { /* skip broken ones, try next */ }
    }
    if (newImages.length) {
      product.images = [...product.images, ...newImages];
      await product.save();
      updated++;
      console.log(` added ${newImages.length}, now ${product.images.length} total`);
    } else {
      console.log(" all candidates failed to download");
    }
  }

  console.log(`\n[SUCCESS] Updated ${updated} smartphones with additional real images`);
  await mongoose.disconnect();
  process.exit(0);
}
run().catch((e) => { console.error("[ERROR]", e); process.exit(1); });

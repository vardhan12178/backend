/**
 * ADDS real Indian ethnic-wear / jewellery / footwear / handbags / watches
 * products alongside the existing Zara/Western-sourced fashion catalog
 * (does not delete anything), plus a batch of Indian-market menswear
 * brands. Source: Amazon India per-category dataset (same one used for
 * cricket/sunglasses/beauty earlier this session).
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { parse } from "csv-parse/sync";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Product from "../models/Product.js";

const BUCKET = process.env.S3_BUCKET || "vkart-assets-mumbai";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "ap-south-1";
const s3 = new S3Client({ region: REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
const SCRATCH = "C:\\Users\\balav\\AppData\\Local\\Temp\\claude\\C--Users-balav-projects-vkart\\8d2147d4-f81f-455b-a08c-414156dd3c48\\scratchpad\\kaggle_check\\amazon_in";

const INDIAN_NAMES = ["Rahul", "Priya", "Amit", "Sneha", "Vikram", "Anjali", "Karthik", "Neha", "Rohan", "Sanya", "Arjun", "Ishita"];
const REVIEW_LINES = ["Value for money, works exactly as described.", "Good quality, delivery was fast too.", "Great fit and finish, happy with the purchase.", "Perfect for festive occasions, loved it.", "Fast delivery, product matches the listing perfectly."];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function makeReviews(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = pick(INDIAN_NAMES);
    out.push({ rating: pick([4, 4, 5, 5, 3]), comment: pick(REVIEW_LINES), reviewerName: name, reviewerEmail: `${name.toLowerCase()}${rand(100, 999)}@example.com`, date: new Date(Date.now() - rand(0, 90) * 86400000) });
  }
  return out;
}
function upgradeAmazonImageUrl(url) {
  const m = url.match(/\/images\/I\/([A-Za-z0-9+_-]+)\.[^/?]*\.(jpg|jpeg|png)/i);
  if (m) return `https://m.media-amazon.com/images/I/${m[1]}._AC_SL1500_.${m[2]}`;
  return url;
}
async function downloadImage(url) {
  const res = await fetch(url.trim(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1500) throw new Error("too small");
  return buf;
}
async function uploadToS3(buffer, key) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: "image/jpeg", ServerSideEncryption: "AES256" }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}
async function rehost(urls, prefix) {
  const out = [];
  for (let i = 0; i < urls.length && out.length < 3; i++) {
    try {
      const buf = await downloadImage(urls[i]);
      const key = `product-images/${prefix}-${Math.random().toString(36).slice(2, 10)}-${i}.jpg`;
      out.push(await uploadToS3(buf, key));
    } catch (e) { console.log(`    img fail: ${e.message}`); }
  }
  return out;
}
function buildDoc({ title, brand, category, price, description, images }) {
  const stock = rand(10, 60);
  return {
    title, description, category, brand: brand || "", price,
    discountPercentage: pick([0, 5, 8, 10, 12]),
    rating: +(3.6 + Math.random() * 1.3).toFixed(2),
    stock, minimumOrderQuantity: 1,
    sku: `${category.toUpperCase()}-${Math.random().toString(36).slice(2, 10)}`,
    tags: [category, "indian"],
    weight: rand(100, 1200),
    warrantyInformation: "No warranty on wear items",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: images[0], images,
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: [], isActive: true, isFeatured: Math.random() < 0.15, isIndianized: true,
  };
}

function parseAmazonIn(filename) {
  const raw = fs.readFileSync(path.join(SCRATCH, filename), "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  return rows.filter((r) => r.name && r.image && r.image.startsWith("http")).map((r) => {
    const priceStr = (r.discount_price || r.actual_price || "").replace(/[^\d.]/g, "");
    const price = Math.round(parseFloat(priceStr) || 0);
    const brandMatch = r.name.match(/^([A-Z][A-Za-z0-9&'.]*(?:\s[A-Z][A-Za-z0-9&'.]*){0,2})/);
    return { title: r.name.trim().slice(0, 150), brand: brandMatch ? brandMatch[1].trim() : "", image: upgradeAmazonImageUrl(r.image), price };
  }).filter((r) => r.price > 0);
}

async function importBatch(rows, category, target, skuPrefix) {
  const docs = [];
  let idx = 0;
  const seen = new Set();
  for (const row of rows) {
    if (docs.length >= target) break;
    const key = row.title.trim().toLowerCase();
    if (seen.has(key)) { idx++; continue; }
    seen.add(key);
    process.stdout.write(`  [${docs.length + 1}/${target}] ${row.title.slice(0, 45)}...`);
    const images = await rehost([row.image], `${skuPrefix}${idx}`);
    if (images.length) {
      docs.push(buildDoc({ title: row.title, brand: row.brand, category, price: row.price, description: `${row.title}\n• Brand: ${row.brand || "N/A"}`, images }));
      console.log(" OK");
    } else console.log(" SKIP");
    idx++;
  }
  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`[SUCCESS] Added ${r.length} to ${category}`);
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] Connected");

  const only = process.argv[2] ? process.argv[2].split(",") : ["dresses", "bags", "jewellery", "shoes", "watches", "mens"];

  if (only.includes("dresses")) {
    const rows = parseAmazonIn("Ethnic Wear.csv").filter((r) => /women|kurta|saree|lehenga|dupatta/i.test(r.title));
    console.log(`\n[INFO] Ethnic dresses: ${rows.length} candidates`);
    await importBatch(rows, "womens-dresses", 18, "ETHNIC");
  }
  if (only.includes("bags")) {
    const rows = parseAmazonIn("Handbags and Clutches.csv").filter((r) => /women/i.test(r.title));
    console.log(`\n[INFO] Indian handbags: ${rows.length} candidates`);
    await importBatch(rows, "womens-bags", 15, "INBAG");
  }
  if (only.includes("jewellery")) {
    const ethnicRe = /jhumka|kundan|mangalsutra|choker|meenakari|temple jewellery|bangles|necklace set|jhumki|earrings|bindi|maang tikka/i;
    const rows = parseAmazonIn("Jewellery.csv").filter((r) => ethnicRe.test(r.title));
    console.log(`\n[INFO] Ethnic jewellery: ${rows.length} candidates`);
    await importBatch(rows, "womens-jewellery", 18, "INJEWEL");
  }
  if (only.includes("shoes")) {
    const ethnicRe = /jutti|jooti|mojari|kolhapuri|ethnic/i;
    const womensRows = parseAmazonIn("Fashion%20Sandals.csv").filter((r) => ethnicRe.test(r.title));
    console.log(`\n[INFO] Ethnic womens footwear: ${womensRows.length} candidates`);
    await importBatch(womensRows, "womens-shoes", 15, "INSHOE");

    const mensRows = parseAmazonIn("Casual Shoes.csv").filter((r) => ethnicRe.test(r.title));
    console.log(`\n[INFO] Ethnic mens footwear: ${mensRows.length} candidates`);
    await importBatch(mensRows, "mens-shoes", 12, "INMSHOE2");
  }
  if (only.includes("watches")) {
    const rows = parseAmazonIn("Watches.csv").filter((r) => /titan|fastrack|sonata/i.test(r.title) && /women|ladies/i.test(r.title));
    console.log(`\n[INFO] Indian brand womens watches: ${rows.length} candidates`);
    await importBatch(rows, "womens-watches", 15, "INWATCH");
  }
  if (only.includes("mens")) {
    const brandRe = /us polo|zara|allen solly|louis philippe|van heusen|peter england|arrow|rare rabbit|roadster|highlander|hrx|jack ?& ?jones|flying machine|celio/i;
    const shirtTypeRe = /\bshirt\b|\bpolo shirt\b|\bt-?shirt\b|\btshirt\b/i;
    const footwearRe = /sneaker|slider|mule|loafer|sandal|slip.?on|driver|\bshoe\b/i;
    const shirtRows = parseAmazonIn("Mens Fashion.csv").filter((r) => brandRe.test(r.title) && shirtTypeRe.test(r.title) && !footwearRe.test(r.title));
    const shoeRows = parseAmazonIn("Mens Fashion.csv").filter((r) => brandRe.test(r.title) && footwearRe.test(r.title));
    console.log(`\n[INFO] Mens shirts (branded): ${shirtRows.length} candidates`);
    await importBatch(shirtRows, "mens-shirts", 14, "INMSHIRT");
    console.log(`\n[INFO] Mens shoes (branded): ${shoeRows.length} candidates`);
    await importBatch(shoeRows, "mens-shoes", 10, "INMSHOE");
  }

  console.log("\n[INFO] Done.");
  await mongoose.disconnect();
  process.exit(0);
}
run().catch((e) => { console.error("[ERROR]", e); process.exit(1); });

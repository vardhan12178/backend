/**
 * Adds a real secondary photo to smartphones/laptops that still only have
 * 1 image, via Wikimedia Commons file search (the same technique already
 * proven for tablets earlier this session). Applied per distinct product
 * LINE for laptops (many DB rows are just RAM/CPU variants of the same
 * physical chassis), and per exact model for phones.
 */
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Product from "../models/Product.js";

const BUCKET = process.env.S3_BUCKET || "vkart-assets-mumbai";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "ap-south-1";
const s3 = new S3Client({ region: REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
const UA = "VKartCatalogBot/1.0 (contact: balavardhanpula@gmail.com)";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const BAD_FILE_RE = /\.pdf$|\.svg$|logo|diagram|\.stl$|icon\b/i;

async function findCommonsImage(query) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=6&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const data = await res.json();
  const hits = (data?.query?.search || []).filter((h) => !BAD_FILE_RE.test(h.title));
  if (!hits.length) return null;
  const title = hits[0].title;
  const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&iiurlwidth=800&format=json`;
  const infoRes = await fetch(infoUrl, { headers: { "User-Agent": UA } });
  const infoData = await infoRes.json();
  const pages = infoData?.query?.pages || {};
  const page = Object.values(pages)[0];
  const info = page?.imageinfo?.[0];
  return info?.thumburl || info?.url || null;
}

async function downloadImage(url) {
  const res = await fetch(url.trim(), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) throw new Error("too small");
  return buf;
}
async function uploadToS3(buffer, key, ext) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: ext === "png" ? "image/png" : "image/jpeg", ServerSideEncryption: "AES256" }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function addSecondaryImage(label, searchQuery, products) {
  if (!products.length) return false;
  process.stdout.write(`${label} (${products.length} product${products.length > 1 ? "s" : ""})...`);
  try {
    const imgUrl = await findCommonsImage(searchQuery);
    if (!imgUrl) { console.log(" no Commons match"); return false; }
    const buf = await downloadImage(imgUrl);
    const ext = /\.png(\?|$)/i.test(imgUrl) ? "png" : "jpg";
    for (const p of products) {
      const key = `product-images/${p.category.toUpperCase()}-${p._id}-2nd${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const url = await uploadToS3(buf, key, ext);
      p.images = [...p.images, url];
      await p.save();
    }
    console.log(` OK -> ${products.length} product(s) updated`);
    return true;
  } catch (e) {
    console.log(` FAILED (${e.message})`);
    return false;
  } finally {
    await delay(1200);
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] Connected\n=== PHONES ===");

  const phoneTargets = [
    { title: /Galaxy S25 Ultra/i, q: "Samsung Galaxy S25 Ultra smartphone" },
    { title: /Galaxy S24 FE/i, q: "Samsung Galaxy S24 FE smartphone" },
    { title: /Galaxy S24 5G \(/i, q: "Samsung Galaxy S24 smartphone" },
    { title: /Galaxy A56/i, q: "Samsung Galaxy A56 smartphone" },
    { title: /Galaxy A36/i, q: "Samsung Galaxy A36 smartphone" },
    { title: /Pixel 9 Pro XL/i, q: "Google Pixel 9 Pro XL smartphone" },
    { title: /Pixel 9 \(/i, q: "Google Pixel 9 smartphone" },
    { title: /Redmi Note 14 Pro\+/i, q: "Redmi Note 14 Pro Plus smartphone" },
    { title: /POCO X7 Pro/i, q: "POCO X7 Pro smartphone" },
    { title: /vivo X200/i, q: "vivo X200 smartphone" },
    { title: /vivo X100 Pro/i, q: "vivo X100 Pro smartphone" },
    { title: /vivo V50 5G/i, q: "vivo V50 smartphone" },
    { title: /realme GT 6/i, q: "realme GT 6 smartphone" },
    { title: /realme 14 Pro\+/i, q: "realme 14 Pro Plus smartphone" },
    { title: /OPPO Reno13/i, q: "Oppo Reno 13 smartphone" },
    { title: /OPPO F29/i, q: "Oppo F29 smartphone" },
    { title: /Edge 60 Pro/i, q: "Motorola Edge 60 Pro smartphone" },
    { title: /Edge 50 Ultra/i, q: "Motorola Edge 50 Ultra smartphone" },
    { title: /IQOO 13/i, q: "iQOO 13 smartphone" },
    { title: /Infinix GT 20 Pro/i, q: "Infinix GT 20 Pro smartphone" },
    { title: /Nothing Phone 2 Pro/i, q: "CMF Phone 2 Pro Nothing smartphone" },
    { title: /iPhone 16 Pro Max/i, q: "iPhone 16 Pro Max back" },
    { title: /iPhone 16 Pro \(/i, q: "iPhone 16 Pro back" },
    { title: /iPhone 16e/i, q: "iPhone 16e smartphone" },
    { title: /iPhone 16 \(/i, q: "iPhone 16 back" },
  ];

  for (const t of phoneTargets) {
    const products = await Product.find({ category: "smartphones", title: t.title, "images.1": { $exists: false } });
    await addSecondaryImage(t.q, t.q, products);
  }

  console.log("\n=== LAPTOP LINES ===");
  const laptopTargets = [
    { title: /MacBook AIR M2/i, q: "MacBook Air M2 laptop" },
    { title: /Galaxy Book4 Edge/i, q: "Samsung Galaxy Book4 Edge laptop" },
    { title: /Galaxy Book4 Metal/i, q: "Samsung Galaxy Book4 laptop" },
    { title: /Lenovo IdeaPad Slim 3/i, q: "Lenovo IdeaPad Slim 3 laptop" },
    { title: /Lenovo IdeaPad Slim 5/i, q: "Lenovo IdeaPad Slim 5 laptop" },
    { title: /ASUS Vivobook 15/i, q: "Asus Vivobook 15 laptop" },
    { title: /ASUS Vivobook 14/i, q: "Asus Vivobook 14 laptop" },
    { title: /ASUS Vivobook Go 15/i, q: "Asus Vivobook Go 15 laptop" },
    { title: /ASUS Vivobook S16/i, q: "Asus Vivobook S16 OLED laptop" },
    { title: /ASUS Expertbook P1/i, q: "Asus ExpertBook P1 laptop" },
    { title: /Acer Aspire 3\b/i, q: "Acer Aspire 3 laptop" },
    { title: /Acer Aspire 15\b/i, q: "Acer Aspire laptop" },
    { title: /Acer Aspire Lite/i, q: "Acer Aspire laptop" },
    { title: /DELL 15/i, q: "Dell Inspiron 15 laptop" },
    { title: /MSI Thin A15/i, q: "MSI gaming laptop" },
  ];

  for (const t of laptopTargets) {
    const products = await Product.find({ category: "laptops", title: t.title, "images.1": { $exists: false } });
    await addSecondaryImage(t.q, t.q, products);
  }

  console.log("\n[INFO] Done.");
  await mongoose.disconnect();
  process.exit(0);
}
run().catch((e) => { console.error("[ERROR]", e); process.exit(1); });

/**
 * Full rebuild of the smartphones category from a single reliable source:
 * a real Flipkart India current-inventory scrape (2024-2025), which has
 * consistently produced clean product-only photos (unlike the mixed
 * Amazon-US + Wikipedia approach, which pulled in showroom/mismatched
 * images for several models).
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
const CSV_PATH = "C:\\Users\\balav\\AppData\\Local\\Temp\\claude\\C--Users-balav-projects-vkart\\8d2147d4-f81f-455b-a08c-414156dd3c48\\scratchpad\\kaggle_check\\flipkart2024\\flipkart_smartphones.csv";

const INDIAN_NAMES = ["Rahul", "Priya", "Amit", "Sneha", "Vikram", "Anjali", "Karthik", "Neha", "Rohan", "Sanya"];
const REVIEW_LINES = ["Value for money, works exactly as described.", "Good quality, delivery was fast too.", "Better than expected for the price range.", "Great performance for daily use, happy with the purchase."];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function makeReviews(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = pick(INDIAN_NAMES);
    out.push({ rating: pick([4, 4, 5, 5]), comment: pick(REVIEW_LINES), reviewerName: name, reviewerEmail: `${name.toLowerCase()}${rand(100, 999)}@example.com`, date: new Date(Date.now() - rand(0, 60) * 86400000) });
  }
  return out;
}
function upsizeFlipkartImage(url) {
  return url.replace(/\/image\/\d+\/\d+\//, "/image/832/832/");
}
async function downloadImage(url) {
  const res = await fetch(url.trim(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error("too small");
  return buf;
}
async function uploadToS3(buffer, key) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: "image/jpeg", ServerSideEncryption: "AES256" }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}
function buildDoc({ title, brand, price, images }) {
  const stock = rand(15, 70);
  return {
    title, description: `${title}\n• Brand: ${brand}\n• Connectivity: 5G/4G\n• Current-generation model`,
    category: "smartphones", brand, price,
    discountPercentage: pick([5, 8, 10, 12, 15]),
    rating: +(3.7 + Math.random() * 1.2).toFixed(2),
    stock, minimumOrderQuantity: 1,
    sku: `SMARTPHONES-${Math.random().toString(36).slice(2, 10)}`,
    tags: ["smartphones", brand.toLowerCase()],
    weight: rand(150, 250),
    warrantyInformation: "1 year manufacturer warranty",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: images[0], images,
    reviews: makeReviews(pick([1, 2, 2])),
    variants: [], isActive: true, isFeatured: Math.random() < 0.2, isIndianized: true,
  };
}

// Curated: real, currently-active (2024-2025) models confirmed present in the dataset,
// spanning the brands an Indian storefront would actually carry.
const TARGETS = [
  { match: /^Apple iPhone 16 Pro Max/i, brand: "Apple" },
  { match: /^Apple iPhone 16 Pro\b(?!\s*Max)/i, brand: "Apple" },
  { match: /^Apple iPhone 16\b(?!\s*(Pro|e))/i, brand: "Apple" },
  { match: /^Apple iPhone 16e/i, brand: "Apple" },
  { match: /^Apple iPhone 15 Plus/i, brand: "Apple" },
  { match: /^Apple iPhone 15\b(?!\s*Plus)/i, brand: "Apple" },
  { match: /^Apple iPhone 14\b/i, brand: "Apple" },
  { match: /^SAMSUNG Galaxy S25 Ultra/i, brand: "Samsung" },
  { match: /^SAMSUNG Galaxy S24 Ultra/i, brand: "Samsung" },
  { match: /^SAMSUNG Galaxy S24 FE/i, brand: "Samsung" },
  { match: /^SAMSUNG Galaxy S24 5G/i, brand: "Samsung" },
  { match: /^SAMSUNG Galaxy S23 FE/i, brand: "Samsung" },
  { match: /^SAMSUNG Galaxy A56/i, brand: "Samsung" },
  { match: /^SAMSUNG Galaxy A36/i, brand: "Samsung" },
  { match: /^Google Pixel 9 Pro XL/i, brand: "Google" },
  { match: /^Google Pixel 9 Pro\b(?!\s*XL)/i, brand: "Google" },
  { match: /^Google Pixel 9\b(?!\s*Pro)/i, brand: "Google" },
  { match: /^Google Pixel 8a/i, brand: "Google" },
  { match: /^REDMI Note 14 Pro\+ 5G/i, brand: "Redmi" },
  { match: /^REDMI Note 13 Pro\+ 5G/i, brand: "Redmi" },
  { match: /^POCO X7 Pro 5G/i, brand: "POCO" },
  { match: /^POCO F6 5G/i, brand: "POCO" },
  { match: /^vivo X200 5G/i, brand: "Vivo" },
  { match: /^vivo X100 Pro/i, brand: "Vivo" },
  { match: /^vivo V50 5G\b/i, brand: "Vivo" },
  { match: /^realme GT 6/i, brand: "Realme" },
  { match: /^realme 14 Pro\+ 5G/i, brand: "Realme" },
  { match: /^OPPO Reno13 5G/i, brand: "Oppo" },
  { match: /^OPPO F29 5G/i, brand: "Oppo" },
  { match: /^MOTOROLA Edge 60 Pro/i, brand: "Motorola" },
  { match: /^Motorola Edge 50 Ultra/i, brand: "Motorola" },
  { match: /^IQOO 13 5G/i, brand: "iQOO" },
  { match: /^Infinix GT 20 Pro/i, brand: "Infinix" },
  { match: /^CMF by Nothing Phone 2 Pro/i, brand: "Nothing" },
  { match: /^Nothing Phone\b/i, brand: "Nothing" },
];

// Rough current INR street prices (dataset "Discounted Price" is often unreliable/promo-skewed)
const PRICE_HINTS = {
  "iphone 16 pro max": 144900, "iphone 16 pro": 129900, "iphone 16e": 59900, "iphone 16": 79900,
  "iphone 15 plus": 79900, "iphone 15": 69900, "iphone 14": 59900,
  "s25 ultra": 129999, "s24 ultra": 114999, "s24 fe": 54999, "galaxy s24 5g": 69999, "s23 fe": 44999,
  "a56": 34999, "a36": 27999, "pixel 9 pro xl": 119999, "pixel 9 pro": 99999, "pixel 9": 74999, "pixel 8a": 52999,
  "note 14 pro+": 27999, "note 13 pro+": 26999, "poco x7 pro": 26999, "poco f6": 29999,
  "x200 5g": 54999, "x100 pro": 69990, "v50 5g": 34999,
  "gt 6": 36999, "14 pro+": 32999, "reno13 5g": 32999, "f29 5g": 24999,
  "edge 60 pro": 39999, "edge 50 ultra": 59999, "iqoo 13": 54999, "gt 20 pro": 25999,
  "phone 2 pro": 21999, "nothing phone": 32999,
};
function guessPrice(name) {
  const lower = name.toLowerCase();
  for (const [key, price] of Object.entries(PRICE_HINTS)) {
    if (lower.includes(key)) return price;
  }
  return 29999;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] Connected");

  const delR = await Product.deleteMany({ category: "smartphones" });
  console.log(`[INFO] Cleared ${delR.deletedCount} existing smartphones`);

  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  console.log(`[INFO] Parsed ${rows.length} Flipkart rows`);

  const docs = [];
  for (let i = 0; i < TARGETS.length; i++) {
    const t = TARGETS[i];
    const row = rows.find((r) => t.match.test((r.Name || "").trim()) && r["Image URL"] && r["Image URL"].startsWith("http"));
    const cleanName = row ? row.Name.replace(/,\s*\d+\s*GB\)$/, ")").trim() : null;
    process.stdout.write(`  [${i + 1}/${TARGETS.length}] ${t.match.source.replace(/[\^\\]/g, "").slice(0, 35)}...`);
    if (!row) { console.log(" NO MATCH"); continue; }
    const imgUrl = upsizeFlipkartImage(row["Image URL"]);
    try {
      const buf = await downloadImage(imgUrl);
      const key = `product-images/SMARTPHONES-FK${i}-0.jpg`;
      const hostedUrl = await uploadToS3(buf, key);
      docs.push(buildDoc({ title: cleanName, brand: t.brand, price: guessPrice(cleanName), images: [hostedUrl] }));
      console.log(` OK (${cleanName})`);
    } catch (e) {
      console.log(` SKIP (${e.message})`);
    }
  }

  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`\n[SUCCESS] Inserted ${r.length} smartphones from Flipkart`);
  }
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => { console.error("[ERROR]", e); process.exit(1); });

/**
 * Replaces the placeholder-image fashion/furniture/home-decor products
 * (loremflickr stock photos) with real products sourced from Kaggle
 * (Zara clothing dataset + Amazon furniture dataset), re-hosting each
 * image to our own S3 bucket instead of hotlinking the source CDN.
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
const SCRATCH = "C:\\Users\\balav\\AppData\\Local\\Temp\\claude\\C--Users-balav-projects-vkart\\8d2147d4-f81f-455b-a08c-414156dd3c48\\scratchpad\\kaggle_check";

const INDIAN_NAMES = ["Rahul", "Priya", "Amit", "Sneha", "Vikram", "Anjali", "Karthik", "Neha", "Rohan", "Sanya", "Arjun", "Ishita", "Aditya", "Meera", "Siddharth", "Kavya"];
const REVIEW_LINES = [
  "Value for money, works exactly as described.",
  "Good quality, delivery was fast too.",
  "Better than expected for the price range.",
  "Solid quality, would recommend to others.",
  "Fast delivery, product matches the listing perfectly.",
  "Great fit and finish, happy with the purchase.",
];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function makeReviews(count) {
  const used = new Set();
  const reviews = [];
  for (let i = 0; i < count; i++) {
    let name;
    do { name = pick(INDIAN_NAMES); } while (used.has(name) && used.size < INDIAN_NAMES.length);
    used.add(name);
    reviews.push({ rating: pick([4, 4, 5, 5, 5, 3]), comment: pick(REVIEW_LINES), reviewerName: name, reviewerEmail: `${name.toLowerCase()}${rand(100, 999)}@example.com`, date: new Date(Date.now() - rand(0, 90) * 86400000) });
  }
  return reviews;
}

async function downloadImage(url) {
  const res = await fetch(url.trim(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error("Image too small, likely broken");
  return buf;
}

async function uploadToS3(buffer, key, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: "AES256" }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function rehostImages(urls, skuBase) {
  const out = [];
  for (let i = 0; i < urls.length && out.length < 3; i++) {
    try {
      const buf = await downloadImage(urls[i]);
      const ext = /\.png(\?|$)/i.test(urls[i]) ? "png" : "jpg";
      const key = `product-images/${skuBase}-${i}.${ext}`;
      const url = await uploadToS3(buf, key, ext === "png" ? "image/png" : "image/jpeg");
      out.push(url);
    } catch (e) {
      console.log(`    [WARN] image failed (${e.message}): ${urls[i]?.slice(0, 60)}`);
    }
  }
  return out;
}

// ---------------- ZARA PARSING ----------------
function getField(row, ...names) {
  for (const n of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === n.toLowerCase()) return row[key];
    }
  }
  return "";
}

function parseZaraCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  return rows.map((r) => {
    const imgCol = getField(r, "product_images", "product_image");
    const imgMatches = [...imgCol.matchAll(/https:\/\/static\.zara\.net\/[^'"]+/g)].map((m) => m[0]);
    const priceStr = getField(r, "price").replace(/[^\d.]/g, "");
    const price = Math.round(parseFloat(priceStr) || 0);
    return { title: getField(r, "product_name").trim(), images: imgMatches, price, details: getField(r, "details").trim() };
  }).filter((r) => r.title && r.images.length && r.price > 0);
}

// ---------------- AMAZON FURNITURE PARSING ----------------
function parseFurnitureCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  const FURNITURE_KEYWORDS = /chair|table|cabinet|rack|stool|sofa|shelf|desk|bed|dresser|ottoman|bench|drawer/i;
  return rows.map((r) => {
    const imgMatches = [...(r.images || "").matchAll(/https:\/\/[^\s'"]+/g)].map((m) => m[0]);
    const priceUSD = parseFloat((r.price || "").replace(/[^\d.]/g, "")) || 0;
    const priceINR = priceUSD > 0 ? Math.round(priceUSD * 84 / 10) * 10 : 0;
    const isFurniture = FURNITURE_KEYWORDS.test(r.title || "");
    return {
      title: (r.title || "").trim().slice(0, 120),
      brand: (r.brand || "").trim(),
      images: imgMatches,
      price: priceINR,
      description: (r.description || r.about_item || "").trim().slice(0, 600) || (r.title || "").trim(),
      category: isFurniture ? "furniture" : "home-decoration",
      material: (r.material || "").trim(),
      color: (r.color || "").trim(),
    };
  }).filter((r) => r.title && r.images.length && r.price > 0);
}

function zaraDesc(brand, title, details) {
  return `${title}, by ${brand}.\n• ${details || "Premium quality construction with attention to detail."}\n• Brand: ${brand}\n• Care: Follow garment label instructions`;
}

async function buildZaraDoc(row, category, brand, sku) {
  const images = await rehostImages(row.images, sku);
  if (!images.length) return null;
  const stock = rand(10, 80);
  return {
    title: row.title,
    description: zaraDesc(brand, row.title, row.details),
    category,
    brand,
    price: row.price,
    discountPercentage: pick([0, 5, 8, 10, 12]),
    rating: +(3.6 + Math.random() * 1.3).toFixed(2),
    stock,
    minimumOrderQuantity: 1,
    sku,
    tags: [category, brand.toLowerCase()],
    weight: rand(150, 1500),
    warrantyInformation: "No warranty on wear items",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "14 days return policy",
    thumbnail: images[0],
    images,
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: [],
    isActive: true,
    isFeatured: Math.random() < 0.2,
    isIndianized: true,
  };
}

async function buildFurnitureDoc(row, sku) {
  const images = await rehostImages(row.images, sku);
  if (!images.length) return null;
  const stock = rand(10, 60);
  return {
    title: row.title,
    description: `${row.description}${row.material ? `\n• Material: ${row.material}` : ""}${row.color ? `\n• Color: ${row.color}` : ""}`,
    category: row.category,
    brand: row.brand || "",
    price: row.price,
    discountPercentage: pick([0, 5, 8, 10, 12]),
    rating: +(3.5 + Math.random() * 1.4).toFixed(2),
    stock,
    minimumOrderQuantity: 1,
    sku,
    tags: [row.category],
    weight: rand(300, 5000),
    warrantyInformation: row.category === "furniture" ? "1 year manufacturer warranty" : "No warranty",
    shippingInformation: "Ships in 3-7 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: images[0],
    images,
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: [],
    isActive: true,
    isFeatured: Math.random() < 0.15,
    isIndianized: true,
  };
}

const ZARA_SOURCES = [
  { file: "zara/men/SHIRTS.csv", category: "mens-shirts", target: 28 },
  { file: "zara/men/SHOES.csv", category: "mens-shoes", target: 28 },
  { file: "zara/DRESSES_JUMPSUITS.csv", category: "womens-dresses", target: 28 },
  { file: "zara/SHIRTS.csv", category: "tops", target: 28 },
  { file: "zara/SHOES.csv", category: "womens-shoes", target: 28 },
  { file: "zara/BAGS.csv", category: "womens-bags", target: 28 },
  { file: "zara/ACCESSORIES_JEWELLERY.csv", category: "womens-jewellery", target: 28 },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const onlyArg = process.argv[2]; // optional: comma-separated category list to restrict this run to
  const only = onlyArg ? onlyArg.split(",") : null;
  const zaraSources = only ? ZARA_SOURCES.filter((s) => only.includes(s.category)) : ZARA_SOURCES;
  const doFurniture = !only || only.includes("furniture") || only.includes("home-decoration");

  const targetCategories = [...zaraSources.map((s) => s.category), ...(doFurniture ? ["furniture", "home-decoration"] : [])];
  const delResult = await Product.deleteMany({ thumbnail: /loremflickr\.com/, category: { $in: targetCategories } });
  console.log(`[INFO] Deleted ${delResult.deletedCount} placeholder products in target categories: ${targetCategories.join(", ")}`);

  let totalInserted = 0;

  for (const src of zaraSources) {
    const rows = parseZaraCsv(path.join(SCRATCH, src.file));
    console.log(`\n[INFO] ${src.category}: parsed ${rows.length} usable rows from ${src.file}, targeting ${src.target}`);
    const docs = [];
    let idx = 0;
    for (const row of rows) {
      if (docs.length >= src.target) break;
      const sku = `${src.category.toUpperCase()}-Z${idx}`;
      process.stdout.write(`  [${docs.length + 1}/${src.target}] ${row.title.slice(0, 40)}...`);
      const doc = await buildZaraDoc(row, src.category, "Zara", sku);
      if (doc) { docs.push(doc); console.log(" OK"); } else { console.log(" SKIP (dead images)"); }
      idx++;
    }
    if (docs.length) {
      const result = await Product.insertMany(docs);
      totalInserted += result.length;
      console.log(`[SUCCESS] Inserted ${result.length} into "${src.category}" (from ${idx} rows tried)`);
    }
  }

  // Furniture + home-decoration from Amazon dataset
  if (!doFurniture) { console.log(`\n[INFO] Done. Total inserted: ${totalInserted}`); await mongoose.disconnect(); process.exit(0); }
  const furnitureRows = parseFurnitureCsv(path.join(SCRATCH, "furniture/furniture_amazon_dataset_sample copy.csv"));
  const furnitureAvail = furnitureRows.filter((r) => r.category === "furniture");
  const decorAvail = furnitureRows.filter((r) => r.category === "home-decoration");
  console.log(`\n[INFO] furniture: ${furnitureAvail.length} rows available, home-decoration: ${decorAvail.length} rows available`);

  for (const [label, avail, target] of [["furniture", furnitureAvail, Math.min(28, furnitureAvail.length)], ["home-decoration", decorAvail, Math.min(28, decorAvail.length)]]) {
    const docs = [];
    let idx = 0;
    for (const row of avail) {
      if (docs.length >= target) break;
      const sku = `${label.toUpperCase()}-A${idx}`;
      process.stdout.write(`  [${docs.length + 1}/${target}] ${row.title.slice(0, 40)}...`);
      const doc = await buildFurnitureDoc(row, sku);
      if (doc) { docs.push(doc); console.log(" OK"); } else { console.log(" SKIP (dead images)"); }
      idx++;
    }
    if (docs.length) {
      const result = await Product.insertMany(docs);
      totalInserted += result.length;
      console.log(`[SUCCESS] Inserted ${result.length} into "${label}" (from ${idx} rows tried)`);
    }
  }

  console.log(`\n[INFO] Done. Total inserted: ${totalInserted}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error("[ERROR]", err); process.exit(1); });

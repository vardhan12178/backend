/**
 * Replaces the loremflickr-based smartphones/laptops/watches (unreliable,
 * often irrelevant or rate-limited/broken) with real products sourced from
 * Kaggle (Amazon phones dataset, Flipkart laptops dataset, Amazon watches
 * dataset), re-hosting each image to our own S3 bucket.
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
const REVIEW_LINES = ["Value for money, works exactly as described.", "Good quality, delivery was fast too.", "Better than expected for the price range.", "Solid quality, would recommend to others.", "Fast delivery, product matches the listing perfectly.", "Great performance for daily use, happy with the purchase."];
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

function upgradeAmazonImageUrl(url) {
  // Amazon CDN encodes size in the filename (e.g. "._AC_SR38,50_.jpg" = 38x50px thumbnail).
  // Swap it for a large variant so we don't re-host tiny stretched-out thumbnails.
  return url.replace(/\._[A-Za-z0-9]+(?:_[A-Za-z0-9,]+)*_\.(jpg|jpeg|png)(\?.*)?$/i, "._AC_SL1500_.$1");
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
      out.push(await uploadToS3(buf, key, ext === "png" ? "image/png" : "image/jpeg"));
    } catch (e) {
      console.log(`    [WARN] image failed (${e.message}): ${urls[i]?.slice(0, 60)}`);
    }
  }
  return out;
}

function buildDoc({ title, brand, category, price, description, images, tags, variants }) {
  const stock = rand(10, 70);
  return {
    title, description, category, brand, price,
    discountPercentage: pick([0, 5, 8, 10, 12, 15]),
    rating: +(3.6 + Math.random() * 1.3).toFixed(2),
    stock, minimumOrderQuantity: 1,
    sku: `${category.toUpperCase()}-${Math.random().toString(36).slice(2, 10)}`,
    tags: tags || [category],
    weight: rand(100, 2500),
    warrantyInformation: "1 year manufacturer warranty",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: images[0], images,
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: variants || [],
    isActive: true, isFeatured: Math.random() < 0.2, isIndianized: true,
  };
}

// ---------------- PHONES ----------------
function parsePhones() {
  const raw = fs.readFileSync(path.join(SCRATCH, "phones/amazon_product_data.csv"), "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  const GOOD_BRANDS = new Set(["SAMSUNG", "Apple", "Google", "OnePlus", "Xiaomi", "Motorola", "Sony", "HUAWEI"]);
  return rows.filter((r) => GOOD_BRANDS.has((r.brand || "").trim()) && r.name && r.price && parseFloat(r.price) > 0).map((r) => {
    const imgs = [...(r.image_links || "").matchAll(/https:\/\/[^\s'"]+/g)].map((m) => m[0]).filter((u) => !u.includes("transparent-pixel")).map(upgradeAmazonImageUrl);
    const priceUSD = parseFloat(r.price) || 0;
    return { title: r.name.trim().slice(0, 120), brand: r.brand.trim(), images: imgs, priceINR: Math.round(priceUSD * 84 / 10) * 10, os: r.os, ram: r.ram, storage: r.storage, screen: r.screen_size };
  }).filter((r) => r.images.length && r.priceINR > 0);
}

// ---------------- LAPTOPS ----------------
function parseLaptops() {
  const raw = fs.readFileSync(path.join(SCRATCH, "laptops2/laptops_20251128_224230.json"), "utf-8");
  const rows = JSON.parse(raw);
  return rows.filter((r) => r.name && r.image_url && r.price > 0).map((r) => ({
    title: r.name.trim().slice(0, 120),
    images: [r.image_url],
    priceINR: Math.round(r.price),
    description: (r.description || "").trim().slice(0, 500),
    rating: r.rating,
  }));
}

// ---------------- WATCHES ----------------
function parseWatches() {
  const raw = fs.readFileSync(path.join(SCRATCH, "watches/Cleaned_Watch_Product_Data.csv"), "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  const mensRe = /men[’']?s\b|for\s+men\b|\bmens\b|\bmen\b/i;
  const womensRe = /women[’']?s\b|for\s+women\b|\bladies\b/i;
  const unisexRe = /\bunisex\b/i;
  const parsed = rows.filter((r) => r["S-image Image"] && r["S-image Description"] && parseFloat(r.Price) > 0).map((r) => {
    const title = r["S-image Description"].trim();
    const priceRaw = parseFloat(r.Price) || 0;
    const priceINR = Math.round(priceRaw * 0.3 / 10) * 10; // source price is in PKR
    const brandMatch = title.match(/^([A-Z][a-zA-Z&|]*(?:\s[A-Z][a-zA-Z&|]*)?)/);
    const isWomens = womensRe.test(title);
    const isMens = mensRe.test(title) && !isWomens;
    const isUnisex = !isMens && !isWomens && unisexRe.test(title);
    return { title: title.slice(0, 120), brand: brandMatch ? brandMatch[1] : "", images: [upgradeAmazonImageUrl(r["S-image Image"])], priceINR: Math.max(priceINR, 500), isWomens, isMens, isUnisex };
  }).filter((r) => r.priceINR > 0);
  return {
    mens: parsed.filter((r) => r.isMens),
    womens: parsed.filter((r) => r.isWomens || r.isUnisex), // genuinely women's-labeled or explicitly unisex only
  };
}

function phoneDesc(row) {
  return `${row.title}\n• Brand: ${row.brand}\n• OS: ${row.os || "N/A"}\n• RAM: ${row.ram || "N/A"}\n• Storage: ${row.storage || "N/A"}\n• Screen: ${row.screen || "N/A"}`;
}
function watchDesc(row) {
  return `${row.title}\n• Brand: ${row.brand || "N/A"}\n• Type: Analog\n• Warranty: 2 years\n• Water Resistance: Up to 30m`;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const only = process.argv[2] ? process.argv[2].split(",") : ["smartphones", "laptops", "mens-watches", "womens-watches"];

  if (only.includes("smartphones")) {
    const delR = await Product.deleteMany({ thumbnail: /loremflickr\.com/, category: "smartphones" });
    console.log(`[INFO] Deleted ${delR.deletedCount} placeholder smartphones`);
    const rows = parsePhones();
    console.log(`[INFO] smartphones: ${rows.length} usable rows`);
    const shuffled = rows.sort(() => Math.random() - 0.5);
    const docs = [];
    let idx = 0;
    for (const row of shuffled) {
      if (docs.length >= 42) break;
      const sku = `PHONE-${idx}`;
      process.stdout.write(`  [${docs.length + 1}/42] ${row.title.slice(0, 40)}...`);
      const images = await rehostImages(row.images, sku);
      if (images.length) {
        docs.push(buildDoc({ title: row.title, brand: row.brand, category: "smartphones", price: row.priceINR, description: phoneDesc(row), images, tags: ["smartphones", row.brand.toLowerCase()] }));
        console.log(" OK");
      } else console.log(" SKIP");
      idx++;
    }
    if (docs.length) { const r = await Product.insertMany(docs); console.log(`[SUCCESS] Inserted ${r.length} smartphones`); }
  }

  if (only.includes("laptops")) {
    const delR = await Product.deleteMany({ thumbnail: /loremflickr\.com/, category: "laptops" });
    console.log(`[INFO] Deleted ${delR.deletedCount} placeholder laptops`);
    const rows = parseLaptops();
    console.log(`[INFO] laptops: ${rows.length} usable rows`);
    const docs = [];
    let idx = 0;
    for (const row of rows) {
      if (docs.length >= 30) break;
      const sku = `LAPTOP-${idx}`;
      process.stdout.write(`  [${docs.length + 1}/30] ${row.title.slice(0, 40)}...`);
      const images = await rehostImages(row.images, sku);
      if (images.length) {
        docs.push(buildDoc({ title: row.title, brand: row.title.split(" ")[0], category: "laptops", price: row.priceINR, description: row.description || row.title, images, tags: ["laptops"] }));
        console.log(" OK");
      } else console.log(" SKIP");
      idx++;
    }
    if (docs.length) { const r = await Product.insertMany(docs); console.log(`[SUCCESS] Inserted ${r.length} laptops`); }
  }

  if (only.includes("mens-watches") || only.includes("womens-watches")) {
    const { mens, womens } = parseWatches();
    console.log(`[INFO] watches: ${mens.length} mens rows, ${womens.length} womens/unisex rows`);

    for (const [cat, rows, target] of [["mens-watches", mens, 28], ["womens-watches", womens, 28]]) {
      if (!only.includes(cat)) continue;
      const delR = await Product.deleteMany({ thumbnail: /loremflickr\.com/, category: cat });
      console.log(`[INFO] Deleted ${delR.deletedCount} placeholder ${cat}`);
      const docs = [];
      let idx = 0;
      for (const row of rows) {
        if (docs.length >= target) break;
        const sku = `${cat.toUpperCase()}-${idx}`;
        process.stdout.write(`  [${docs.length + 1}/${target}] ${row.title.slice(0, 40)}...`);
        const images = await rehostImages(row.images, sku);
        if (images.length) {
          docs.push(buildDoc({ title: row.title, brand: row.brand, category: cat, price: row.priceINR, description: watchDesc(row), images, tags: [cat] }));
          console.log(" OK");
        } else console.log(" SKIP");
        idx++;
      }
      if (docs.length) { const r = await Product.insertMany(docs); console.log(`[SUCCESS] Inserted ${r.length} into ${cat}`); }
    }
  }

  console.log("\n[INFO] Done.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error("[ERROR]", err); process.exit(1); });

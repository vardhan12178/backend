/**
 * Bulks up sports-accessories (cricket), sunglasses, skin-care, beauty,
 * fragrances (all from the real Amazon-India per-category dataset) and
 * tablets (hand-picked real current models with Wikipedia product photos).
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
  // Some rows use the "/W/IMAGERENDERING_.../images/I/{id}._size_.ext" wrapper, which
  // doesn't reliably accept a swapped-in size token. Normalize to the canonical direct
  // "/images/I/{id}._AC_SL1500_.ext" form, which does.
  const m = url.match(/\/images\/I\/([A-Za-z0-9+_-]+)\.[^/?]*\.(jpg|jpeg|png)/i);
  if (m) return `https://m.media-amazon.com/images/I/${m[1]}._AC_SL1500_.${m[2]}`;
  return url.replace(/\._[A-Za-z0-9]+(?:_[A-Za-z0-9,]+)*_\.(jpg|jpeg|png)(\?.*)?$/i, "._AC_SL1500_.$1");
}
async function downloadImage(url) {
  const ua = url.includes("wikimedia.org") ? "VKartCatalogBot/1.0 (contact: balavardhanpula@gmail.com)" : "Mozilla/5.0";
  const res = await fetch(url.trim(), { headers: { "User-Agent": ua } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1500) throw new Error("Image too small, likely a broken/tiny thumbnail");
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

function buildDoc({ title, brand, category, price, description, images, tags }) {
  const stock = rand(10, 70);
  return {
    title, description, category, brand: brand || "", price,
    discountPercentage: pick([0, 5, 8, 10, 12, 15]),
    rating: +(3.6 + Math.random() * 1.3).toFixed(2),
    stock, minimumOrderQuantity: 1,
    sku: `${category.toUpperCase()}-${Math.random().toString(36).slice(2, 10)}`,
    tags: tags || [category],
    weight: rand(50, 2000),
    warrantyInformation: "No warranty on consumable/wear items",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: images[0], images,
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: [],
    isActive: true, isFeatured: Math.random() < 0.2, isIndianized: true,
  };
}

function parseAmazonInCsv(filename) {
  const raw = fs.readFileSync(path.join(SCRATCH, filename), "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  return rows.filter((r) => r.name && r.image && r.image.startsWith("http")).map((r) => {
    const priceStr = (r.discount_price || r.actual_price || "").replace(/[^\d.]/g, "");
    const price = Math.round(parseFloat(priceStr) || 0);
    const brandMatch = r.name.match(/^([A-Z][A-Za-z0-9&'.]*(?:\s[A-Z][A-Za-z0-9&'.]*){0,2})/);
    return { title: r.name.trim().slice(0, 150), brand: brandMatch ? brandMatch[1].trim() : "", images: [upgradeAmazonImageUrl(r.image)], price, ratings: r.ratings };
  }).filter((r) => r.price > 0);
}

async function importFromRows(rows, category, target, skuPrefix, descFn) {
  const delR = await Product.deleteMany({ category, thumbnail: /loremflickr\.com/ });
  if (delR.deletedCount) console.log(`[INFO] Deleted ${delR.deletedCount} placeholder ${category}`);
  console.log(`[INFO] ${category}: ${rows.length} candidate rows, targeting ${target}`);
  const docs = [];
  let idx = 0;
  const seenTitles = new Set();
  for (const row of rows) {
    if (docs.length >= target) break;
    const key = row.title.trim().toLowerCase();
    if (seenTitles.has(key)) { idx++; continue; }
    seenTitles.add(key);
    const sku = `${skuPrefix}-${idx}`;
    process.stdout.write(`  [${docs.length + 1}/${target}] ${row.title.slice(0, 45)}...`);
    const images = await rehostImages(row.images, sku);
    if (images.length) {
      docs.push(buildDoc({ title: row.title, brand: row.brand, category, price: row.price, description: descFn(row), images, tags: [category] }));
      console.log(" OK");
    } else console.log(" SKIP");
    idx++;
  }
  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`[SUCCESS] Inserted ${r.length} into ${category}`);
  }
}

const genericDesc = (row) => `${row.title}\n• Brand: ${row.brand || "N/A"}${row.ratings ? `\n• Rated by ${row.ratings} customers` : ""}`;

// ---------------- TABLETS (hand-picked, Wikipedia images) ----------------
const TABLETS = [
  { title: "Samsung Galaxy Tab A8 (32GB, Wi-Fi)", brand: "Samsung", price: 15999, wiki: "Samsung_Galaxy_Tab_A8" },
  { title: "Xiaomi Pad 6 (128GB, Wi-Fi)", brand: "Xiaomi", price: 26999, wiki: "Xiaomi_Pad_6" },
  { title: "Xiaomi Mi Pad (16GB, Wi-Fi)", brand: "Xiaomi", price: 12999, wiki: "Xiaomi_Mi_Pad" },
  { title: "Amazon Fire HD 10 Tablet (32GB)", brand: "Amazon", price: 14999, wiki: "Amazon_Fire_HD" },
  { title: "Google Pixel Tablet (128GB, Wi-Fi)", brand: "Google", price: 54999, wiki: "Google_Pixel_Tablet" },
  { title: "Microsoft Surface Go 3 (64GB, Wi-Fi)", brand: "Microsoft", price: 49999, wiki: "Microsoft_Surface_Go" },
  { title: "Microsoft Surface Pro 9 (256GB)", brand: "Microsoft", price: 109999, wiki: "Surface_Pro_9" },
];

const WIKI_UA = "VKartCatalogBot/1.0 (contact: balavardhanpula@gmail.com)";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function importTablets() {
  console.log(`[INFO] tablets: ${TABLETS.length} hand-picked rows`);
  const docs = [];
  for (let i = 0; i < TABLETS.length; i++) {
    const t = TABLETS[i];
    process.stdout.write(`  [${i + 1}/${TABLETS.length}] ${t.title.slice(0, 45)}...`);
    try {
      const summary = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.wiki)}`, { headers: { "User-Agent": WIKI_UA } }).then((r) => r.json());
      const imgUrl = summary?.thumbnail?.source;
      await delay(1500);
      if (!imgUrl) { console.log(" SKIP (no wiki image)"); continue; }
      const images = await rehostImages([imgUrl], `TABLETS-${i}`);
      if (!images.length) { console.log(" SKIP (download failed)"); continue; }
      docs.push(buildDoc({
        title: t.title, brand: t.brand, category: "tablets", price: t.price,
        description: `${t.title}\n• Brand: ${t.brand}\n• Connectivity: Wi-Fi\n• Ideal for: Browsing, media, note-taking`,
        images, tags: ["tablets", t.brand.toLowerCase()],
      }));
      console.log(" OK");
    } catch (e) { console.log(` SKIP (${e.message})`); }
  }
  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`[SUCCESS] Inserted ${r.length} into tablets`);
  }
}

// ---------------- SMARTPHONES (hand-picked, verified-current, Wikipedia images) ----------------
const SMARTPHONES = [
  { title: "Apple iPhone 16 (128GB)", brand: "Apple", price: 79900, wiki: "IPhone_16" },
  { title: "Apple iPhone 16 Pro (256GB)", brand: "Apple", price: 129900, wiki: "IPhone_16_Pro" },
  { title: "Apple iPhone 15 (128GB)", brand: "Apple", price: 69900, wiki: "IPhone_15" },
  { title: "Apple iPhone 14 (128GB)", brand: "Apple", price: 59900, wiki: "IPhone_14" },
  { title: "Apple iPhone 13 (128GB)", brand: "Apple", price: 54900, wiki: "IPhone_13" },
  { title: "Apple iPhone SE (2022, 64GB)", brand: "Apple", price: 43900, wiki: "IPhone_SE_(2022)" },
  { title: "Samsung Galaxy S24 (128GB)", brand: "Samsung", price: 79999, wiki: "Samsung_Galaxy_S24" },
  { title: "Samsung Galaxy S24 Ultra (256GB)", brand: "Samsung", price: 129999, wiki: "Samsung_Galaxy_S24_Ultra" },
  { title: "Samsung Galaxy S23 (128GB)", brand: "Samsung", price: 64999, wiki: "Samsung_Galaxy_S23" },
  { title: "Samsung Galaxy Z Fold6 (256GB)", brand: "Samsung", price: 164999, wiki: "Samsung_Galaxy_Z_Fold_6" },
  { title: "Samsung Galaxy Z Flip6 (256GB)", brand: "Samsung", price: 109999, wiki: "Samsung_Galaxy_Z_Flip_6" },
  { title: "Samsung Galaxy A55 5G (128GB)", brand: "Samsung", price: 39999, wiki: "Samsung_Galaxy_A55" },
  { title: "Samsung Galaxy A54 5G (128GB)", brand: "Samsung", price: 34999, wiki: "Samsung_Galaxy_A54" },
  { title: "Google Pixel 8a (128GB)", brand: "Google", price: 52999, wiki: "Google_Pixel_8a" },
  { title: "OnePlus 12R (128GB)", brand: "OnePlus", price: 39999, wiki: "OnePlus_12R" },
  { title: "Xiaomi 14 (256GB)", brand: "Xiaomi", price: 69999, wiki: "Xiaomi_14" },
  { title: "Xiaomi 13 (128GB)", brand: "Xiaomi", price: 54999, wiki: "Xiaomi_13" },
  { title: "Redmi Note 13 Pro+ 5G (256GB)", brand: "Redmi", price: 31999, wiki: "Redmi_Note_13_Pro" },
  { title: "Vivo X100 (256GB)", brand: "Vivo", price: 63999, wiki: "Vivo_X100" },
  { title: "Oppo Find X7 (256GB)", brand: "Oppo", price: 59999, wiki: "Oppo_Find_X7" },
  { title: "Nothing Phone (2) (256GB)", brand: "Nothing", price: 44999, wiki: "Nothing_Phone_2" },
  { title: "Nothing Phone (2a) (256GB)", brand: "Nothing", price: 27999, wiki: "Nothing_Phone_(2a)" },
  { title: "Asus ROG Phone 8 (256GB)", brand: "Asus", price: 69999, wiki: "Asus_ROG_Phone_8" },
  { title: "Sony Xperia 1 V (256GB)", brand: "Sony", price: 119999, wiki: "Sony_Xperia_1_V" },
  { title: "Huawei P60 (256GB)", brand: "Huawei", price: 69999, wiki: "Huawei_P60" },
];

const PHONE_MATCHERS = [
  { title: "Apple iPhone 16 (128GB)", brand: "Apple", price: 79900, re: /iphone 16(?!.*(pro|plus))/i },
  { title: "Apple iPhone 16 Pro (256GB)", brand: "Apple", price: 129900, re: /iphone 16 pro(?!.*max)/i },
  { title: "Apple iPhone 15 (128GB)", brand: "Apple", price: 69900, re: /iphone 15(?!.*(pro|plus))/i },
  { title: "Apple iPhone 14 (128GB)", brand: "Apple", price: 59900, re: /iphone 14(?!.*(pro|plus))/i },
  { title: "Apple iPhone 13 (128GB)", brand: "Apple", price: 54900, re: /iphone 13(?!.*(pro|mini))/i },
  { title: "Apple iPhone SE (2022, 64GB)", brand: "Apple", price: 43900, re: /iphone se/i },
  { title: "Samsung Galaxy S24 (128GB)", brand: "Samsung", price: 79999, re: /galaxy s24(?!.*(ultra|fe|\+|plus))/i },
  { title: "Samsung Galaxy S24 Ultra (256GB)", brand: "Samsung", price: 129999, re: /galaxy s24 ultra/i },
  { title: "Samsung Galaxy S23 (128GB)", brand: "Samsung", price: 64999, re: /galaxy s23(?!.*(ultra|fe|\+|plus))/i },
  { title: "Samsung Galaxy Z Fold6 (256GB)", brand: "Samsung", price: 164999, re: /z fold ?6/i },
  { title: "Samsung Galaxy Z Flip6 (256GB)", brand: "Samsung", price: 109999, re: /z flip ?6/i },
  { title: "Samsung Galaxy A55 5G (128GB)", brand: "Samsung", price: 39999, re: /galaxy a55/i },
  { title: "Samsung Galaxy A54 5G (128GB)", brand: "Samsung", price: 34999, re: /galaxy a54/i },
  { title: "Google Pixel 8a (128GB)", brand: "Google", price: 52999, re: /pixel 8a/i },
  { title: "OnePlus 12R (128GB)", brand: "OnePlus", price: 39999, re: /oneplus 12r/i },
  { title: "Xiaomi 14 (256GB)", brand: "Xiaomi", price: 69999, re: /xiaomi 14\b(?!.*(pro|ultra))/i },
  { title: "Xiaomi 13 (128GB)", brand: "Xiaomi", price: 54999, re: /xiaomi 13\b(?!.*(pro|ultra))/i },
  { title: "Redmi Note 13 Pro+ 5G (256GB)", brand: "Redmi", price: 31999, re: /redmi note 13 pro/i },
  { title: "Vivo X100 (256GB)", brand: "Vivo", price: 63999, re: /vivo x100\b(?!.*pro)/i },
  { title: "Oppo Find X7 (256GB)", brand: "Oppo", price: 59999, re: /oppo find x7/i },
  { title: "Nothing Phone (2) (256GB)", brand: "Nothing", price: 44999, re: /nothing phone.*\(?2\)?(?!a)/i },
  { title: "Nothing Phone (2a) (256GB)", brand: "Nothing", price: 27999, re: /nothing phone.*2a/i },
  { title: "Asus ROG Phone 8 (256GB)", brand: "Asus", price: 69999, re: /rog phone 8/i },
  { title: "Sony Xperia 1 V (256GB)", brand: "Sony", price: 119999, re: /xperia 1 v/i },
  { title: "Huawei P60 (256GB)", brand: "Huawei", price: 69999, re: /huawei p60/i },
];
const BAD_LISTING_RE = /case|cover|screen protector|charger|cable|adapter|holster|skin|sticker|tempered glass|stylus|mount|stand\b/i;

function parseAmazonPhonesRaw() {
  const raw = fs.readFileSync(path.join(SCRATCH, "..", "phones", "amazon_product_data.csv"), "utf-8");
  return parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
}

async function importSmartphonesFromAmazon() {
  const delR = await Product.deleteMany({ category: "smartphones" });
  if (delR.deletedCount) console.log(`[INFO] Cleared ${delR.deletedCount} existing smartphones before rebuild`);
  const rows = parseAmazonPhonesRaw();
  console.log(`[INFO] smartphones: matching against ${rows.length} Amazon listings`);
  const docs = [];
  for (let i = 0; i < PHONE_MATCHERS.length; i++) {
    const spec = PHONE_MATCHERS[i];
    process.stdout.write(`  [${i + 1}/${PHONE_MATCHERS.length}] ${spec.title.slice(0, 40)}...`);
    const candidates = rows.filter((r) => spec.re.test(r.name || "") && !BAD_LISTING_RE.test(r.name || "") && r.image_links && r.image_links !== "[]");
    if (!candidates.length) {
      // fall back to a real Wikipedia photo when no Amazon listing matches
      const wikiTitle = spec.title.replace(/^Apple |^Samsung |^Google |^Redmi /, "").split(" (")[0].replace(/\s+/g, "_");
      console.log(` (no Amazon match, trying Wikipedia: ${wikiTitle})`);
      continue;
    }
    const best = candidates.sort((a, b) => (b.image_links.match(/https/g) || []).length - (a.image_links.match(/https/g) || []).length)[0];
    const imgs = [...best.image_links.matchAll(/https:\/\/[^\s'"]+/g)].map((m) => m[0]).filter((u) => !u.includes("transparent-pixel")).map(upgradeAmazonImageUrl);
    const images = await rehostImages(imgs, `SMARTPHONES-${i}`);
    if (!images.length) { console.log(" SKIP (download failed)"); continue; }
    docs.push(buildDoc({
      title: spec.title, brand: spec.brand, category: "smartphones", price: spec.price,
      description: `${spec.title}\n• Brand: ${spec.brand}\n• Connectivity: 5G/4G\n• Current-generation model`,
      images, tags: ["smartphones", spec.brand.toLowerCase()],
    }));
    console.log(` OK (matched: "${best.name.slice(0, 40)}")`);
  }
  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`[SUCCESS] Inserted ${r.length} into smartphones from real Amazon listings`);
  }
  return PHONE_MATCHERS.filter((_, i) => !docs.some((d) => d.title === PHONE_MATCHERS[i].title));
}

async function importWikiPicks(items, category, descFn) {
  console.log(`[INFO] ${category}: ${items.length} hand-picked rows`);
  const docs = [];
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    process.stdout.write(`  [${i + 1}/${items.length}] ${t.title.slice(0, 45)}...`);
    try {
      const summary = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.wiki)}`, { headers: { "User-Agent": WIKI_UA } }).then((r) => r.json());
      const imgUrl = summary?.thumbnail?.source;
      await delay(1500);
      if (!imgUrl) { console.log(" SKIP (no wiki image)"); continue; }
      const images = await rehostImages([imgUrl], `${category.toUpperCase()}-${i}`);
      if (!images.length) { console.log(" SKIP (download failed)"); continue; }
      docs.push(buildDoc({ title: t.title, brand: t.brand, category, price: t.price, description: descFn(t), images, tags: [category, t.brand.toLowerCase()] }));
      console.log(" OK");
    } catch (e) { console.log(` SKIP (${e.message})`); }
  }
  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`[SUCCESS] Inserted ${r.length} into ${category}`);
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const only = process.argv[2] ? process.argv[2].split(",") : ["sports-accessories", "sunglasses", "skin-care", "beauty", "fragrances", "tablets"];

  if (only.includes("smartphones")) {
    const missing = await importSmartphonesFromAmazon();
    if (missing.length) {
      console.log(`\n[INFO] ${missing.length} models had no Amazon match, falling back to Wikipedia for those:`);
      const wikiFallback = missing.map((m) => SMARTPHONES.find((s) => s.title === m.title)).filter(Boolean);
      await importWikiPicks(wikiFallback, "smartphones", (t) => `${t.title}\n• Brand: ${t.brand}\n• Connectivity: 5G/4G\n• Current-generation model`);
    }
  }

  if (only.includes("sports-accessories")) {
    const rows = parseAmazonInCsv("Cricket.csv");
    await importFromRows(rows, "sports-accessories", 18, "SPORTS-CRICKET", (r) => `${r.title}\n• Brand: ${r.brand || "N/A"}\n• Category: Cricket Equipment${r.ratings ? `\n• Rated by ${r.ratings} customers` : ""}`);
  }
  if (only.includes("sunglasses")) {
    const rows = parseAmazonInCsv("Sunglasses.csv");
    await importFromRows(rows, "sunglasses", 23, "SUNGLASSES", genericDesc);
  }
  if (only.includes("skin-care")) {
    const skinRe = /serum|moisturi[sz]er|sunscreen|face wash|cleanser|toner|face cream|skin/i;
    const rows = [...parseAmazonInCsv("Beauty%20and%20Grooming.csv"), ...parseAmazonInCsv("Luxury%20Beauty.csv")].filter((r) => skinRe.test(r.title));
    await importFromRows(rows, "skin-care", 22, "SKINCARE", genericDesc);
  }
  if (only.includes("beauty")) {
    const rows = parseAmazonInCsv("Make-up.csv");
    await importFromRows(rows, "beauty", 23, "BEAUTY", genericDesc);
  }
  if (only.includes("fragrances")) {
    const fragRe = /perfume|fragrance|eau de|deodorant|body spray|cologne/i;
    const rows = parseAmazonInCsv("Luxury%20Beauty.csv").filter((r) => fragRe.test(r.title));
    await importFromRows(rows, "fragrances", 23, "FRAGRANCE", genericDesc);
  }
  if (only.includes("tablets")) {
    await importTablets();
  }

  console.log("\n[INFO] Done.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error("[ERROR]", err); process.exit(1); });

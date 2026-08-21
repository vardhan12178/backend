/**
 * Full rebuild of the tablets category (minus the 2 legacy DummyJSON
 * entries, which are fine). Fixes two bugs from the earlier pass:
 * 1. S3 keys were index-based (TABLETS-0-0.png), so re-running the
 *    import script across multiple sessions caused later runs to
 *    silently overwrite earlier runs' images at the same key while old
 *    DB docs kept pointing at that now-different file (title/image
 *    mismatches like "Samsung Galaxy Tab S9" showing an iPad photo).
 * 2. Several Wikipedia infobox thumbnails turned out to be store-shelf/
 *    trade-show photos rather than clean product shots. Each image below
 *    was individually verified via Commons file search, not just the
 *    default page summary thumbnail.
 * This version uses a random suffix in every S3 key.
 */
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Product from "../models/Product.js";

const BUCKET = process.env.S3_BUCKET || "vkart-assets-mumbai";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "ap-south-1";
const s3 = new S3Client({ region: REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });

const INDIAN_NAMES = ["Rahul", "Priya", "Amit", "Sneha", "Vikram", "Anjali", "Karthik", "Neha"];
const REVIEW_LINES = ["Value for money, works exactly as described.", "Good quality, delivery was fast too.", "Great performance for daily use, happy with the purchase.", "Solid build quality, would recommend."];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function makeReviews(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = pick(INDIAN_NAMES);
    out.push({ rating: pick([4, 4, 5, 5]), comment: pick(REVIEW_LINES), reviewerName: name, reviewerEmail: `${name.toLowerCase()}${rand(100, 999)}@example.com`, date: new Date() });
  }
  return out;
}
async function downloadImage(url) {
  const res = await fetch(url.trim(), { headers: { "User-Agent": "VKartCatalogBot/1.0 (contact: balavardhanpula@gmail.com)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error("too small");
  return buf;
}
async function uploadToS3(buffer, key, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: "AES256" }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}
function buildDoc({ title, brand, price, images }) {
  const stock = rand(15, 60);
  return {
    title, description: `${title}\n• Brand: ${brand}\n• Connectivity: Wi-Fi\n• Current-generation model`,
    category: "tablets", brand, price,
    discountPercentage: pick([5, 8, 10, 12]),
    rating: +(3.8 + Math.random() * 1.1).toFixed(2),
    stock, minimumOrderQuantity: 1,
    sku: `TABLETS-${Math.random().toString(36).slice(2, 10)}`,
    tags: ["tablets", brand.toLowerCase()],
    weight: rand(400, 700),
    warrantyInformation: "1 year manufacturer warranty",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: "In Stock",
    returnPolicy: "10 days return policy",
    thumbnail: images[0], images,
    reviews: makeReviews(2),
    variants: [], isActive: true, isFeatured: false, isIndianized: true,
  };
}

const TABLETS = [
  { title: "Apple iPad (10th generation, 64GB, Wi-Fi)", brand: "Apple", price: 34900, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/IPad_10.png/960px-IPad_10.png", ext: "png" },
  { title: "Apple iPad Air (64GB, Wi-Fi)", brand: "Apple", price: 59900, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7a/IPad_Air_2020_%2851012790753%29.jpg/960px-IPad_Air_2020_%2851012790753%29.jpg", ext: "jpg" },
  { title: "Apple iPad Pro 11-inch (M5, 256GB)", brand: "Apple", price: 99900, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/11-inch_iPad_Pro_M5_with_Apple_Pencil_Pro.jpg/960px-11-inch_iPad_Pro_M5_with_Apple_Pencil_Pro.jpg", ext: "jpg" },
  { title: "Samsung Galaxy Tab A8 (32GB, Wi-Fi)", brand: "Samsung", price: 15999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Samsung_Galaxy_Tab_A8.jpg/960px-Samsung_Galaxy_Tab_A8.jpg", ext: "jpg" },
  { title: "Samsung Galaxy Tab A9+ (64GB, Wi-Fi)", brand: "Samsung", price: 17999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Samsung_Galaxy_Tab_A9%2B_tablet.jpg/960px-Samsung_Galaxy_Tab_A9%2B_tablet.jpg", ext: "jpg" },
  { title: "Samsung Galaxy Tab S8 (128GB, Wi-Fi)", brand: "Samsung", price: 54999, img: "https://upload.wikimedia.org/wikipedia/commons/0/0a/Galaxy_Tab_S8.png", ext: "png" },
  { title: "Samsung Galaxy Tab S9 (128GB, Wi-Fi)", brand: "Samsung", price: 72999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Samsung_Galaxy_Tab_S9.png/960px-Samsung_Galaxy_Tab_S9.png", ext: "png" },
  { title: "Xiaomi Mi Pad (16GB, Wi-Fi)", brand: "Xiaomi", price: 12999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Mi_pad_on_2.jpg/960px-Mi_pad_on_2.jpg", ext: "jpg" },
  { title: "Redmi Pad Pro (Wi-Fi)", brand: "Redmi", price: 21999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Redmi_Pad_Pro.jpg/960px-Redmi_Pad_Pro.jpg", ext: "jpg" },
  { title: "Amazon Fire HD 10 Tablet (32GB)", brand: "Amazon", price: 14999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Kindle_Fire_HD_8.9.jpg/960px-Kindle_Fire_HD_8.9.jpg", ext: "jpg" },
  { title: "Huawei MatePad 11.5-inch (2024, Wi-Fi)", brand: "Huawei", price: 27999, img: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Huawei_MatePad_11.5-inch_%282024%29_%28Oct_1%2C_2025%29.jpg/960px-Huawei_MatePad_11.5-inch_%282024%29_%28Oct_1%2C_2025%29.jpg", ext: "jpg" },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] Connected");

  // Keep only the 2 legacy DummyJSON tablets, delete everything else in this category
  const keep = ["Samsung Galaxy Tab S8+ Wi-Fi Tablet (Grey, 8GB RAM, 128GB Storage)", "Samsung Galaxy Tab Wi-Fi Tablet (White, 4GB RAM, 64GB Storage)", "Apple iPad Mini (6th Gen) Wi-Fi (64GB, Starlight)"];
  const delR = await Product.deleteMany({ category: "tablets", title: { $nin: keep } });
  console.log(`[INFO] Deleted ${delR.deletedCount} tablets (kept ${keep.length} legacy entries)`);

  const docs = [];
  for (let i = 0; i < TABLETS.length; i++) {
    const t = TABLETS[i];
    process.stdout.write(`  [${i + 1}/${TABLETS.length}] ${t.title.slice(0, 45)}...`);
    try {
      const buf = await downloadImage(t.img);
      const key = `product-images/TABLETS-${Math.random().toString(36).slice(2, 10)}-0.${t.ext}`;
      const url = await uploadToS3(buf, key, t.ext === "png" ? "image/png" : "image/jpeg");
      docs.push(buildDoc({ title: t.title, brand: t.brand, price: t.price, images: [url] }));
      console.log(" OK");
    } catch (e) { console.log(` SKIP (${e.message})`); }
  }
  if (docs.length) {
    const r = await Product.insertMany(docs);
    console.log(`\n[SUCCESS] Inserted ${r.length} tablets`);
  }
  await mongoose.disconnect();
  process.exit(0);
}
run().catch((e) => { console.error("[ERROR]", e); process.exit(1); });

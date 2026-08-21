/**
 * Regenerates thumbnail/images for products seeded with loremflickr
 * placeholders, switching from broken hyphenated keywords (e.g.
 * "iphone-pro", which doesn't match any real Flickr tag) to valid
 * comma-separated single-word tags so images are at least topically
 * correct for the category.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/Product.js";

dotenv.config();

const KEYWORDS = {
  smartphones: "smartphone,mobilephone",
  laptops: "laptop,notebook",
  "mens-shirts": "shirt,menswear",
  "mens-shoes": "shoes,sneakers",
  "mens-watches": "watch,wristwatch",
  "womens-dresses": "dress,fashion",
  tops: "blouse,fashion",
  "womens-shoes": "heels,shoes",
  "womens-bags": "handbag,purse",
  "womens-watches": "watch,jewelry",
  "womens-jewellery": "jewelry,necklace",
  furniture: "furniture,interior",
  "home-decoration": "homedecor,decor",
};

function img(keyword, seed) {
  return `https://loremflickr.com/640/640/${encodeURIComponent(keyword)}?lock=${seed}`;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const products = await Product.find({ thumbnail: /loremflickr\.com/ });
  console.log(`[INFO] Found ${products.length} placeholder-image products to fix`);

  let fixed = 0;
  for (const p of products) {
    const tag = KEYWORDS[p.category];
    if (!tag) continue;
    const seedBase = p._id.toString().slice(-6);
    p.thumbnail = img(tag, seedBase);
    p.images = [1, 2, 3].map((n) => img(tag, seedBase + n));
    await p.save();
    fixed++;
  }
  console.log(`[SUCCESS] Fixed ${fixed} products`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error("[ERROR]", err); process.exit(1); });

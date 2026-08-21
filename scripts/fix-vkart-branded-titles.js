/**
 * Targeted cleanup: re-runs the (now-fixed) indianize prompt only on
 * products whose brand/title still carry the old "VKart" branding bug
 * from the original indianize-data.js run.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const products = await Product.find({ $or: [{ brand: /vkart/i }, { title: /^vkart/i }] });
  console.log(`[INFO] Found ${products.length} VKart-branded products to fix\n`);

  for (const product of products) {
    console.log(`Processing: ${product.title.substring(0, 40)}...`);

    const prompt = `
    You are an expert Content Manager for an Indian E-commerce marketplace (VKart) that sells third-party branded products, similar to Amazon or Flipkart.
    Rewrite this product's title and description so it reads naturally as a normal retail listing.

    CRITICAL: Do NOT use "VKart" as the brand or prefix the title with "VKart" anything. VKart is the marketplace/seller, not the manufacturer. If the category has a real-world brand feel, invent or infer a plausible real-sounding third-party brand. If the product is unbranded (e.g. raw groceries), just describe the item plainly with no brand prefix.

    CURRENT (BUGGY) DATA:
    Title: "${product.title}"
    Description: "${product.description}"
    Category: "${product.category || "General"}"
    Price: ${product.price}

    OUTPUT JSON ONLY:
    { "brand": "...", "title": "...", "description": "..." }
    `;

    let retries = 0;
    const MAX_RETRIES = 5;
    let success = false;

    while (!success && retries <= MAX_RETRIES) {
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, "").trim();
        const aiData = JSON.parse(text);

        if (aiData.brand !== undefined) product.brand = aiData.brand;
        if (aiData.title) product.title = aiData.title;
        if (aiData.description) product.description = aiData.description;

        await product.save();
        console.log(`  [SUCCESS] Brand: "${product.brand}" | Title: "${product.title.substring(0, 40)}..."`);
        success = true;
        await delay(150);
      } catch (err) {
        if (err.message.includes("429")) {
          retries++;
          const waitTime = 1000 * retries;
          console.log(`  [WARN] Rate Limit (Attempt ${retries}). Waiting ${waitTime / 1000}s...`);
          await delay(waitTime);
        } else {
          console.error(`  [ERROR] ${err.message}`);
          break;
        }
      }
    }
  }

  console.log("\n[INFO] Cleanup complete.");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => { console.error("Critical Error:", err); process.exit(1); });

import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";

dotenv.config();

// Keep a short delay between embedding requests.
const BATCH_DELAY = 100;
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 768);

if (!process.env.GEMINI_API_KEY || !process.env.MONGO_URI) {
  console.error("Error: Missing GEMINI_API_KEY or MONGO_URI.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

const vectorizeProducts = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("[INFO] MongoDB Connected.");

    // Process every product so embeddings stay complete.
    const products = await Product.find({});
    console.log(`[INFO] Found ${products.length} products to vectorize...`);

    let successCount = 0;
    let errorCount = 0;

    for (const [index, product] of products.entries()) {
      const textToEmbed = `
        Title: ${product.title}
        Category: ${product.category}
        Description: ${product.description}
        Price: ${product.price}
        Brand: ${product.brand || "Generic"}
      `.trim();

      const payload = {
        content: { parts: [{ text: textToEmbed }] },
      };
      if (Number.isFinite(EMBEDDING_DIM) && EMBEDDING_DIM > 0) {
        payload.outputDimensionality = EMBEDDING_DIM;
      }

      let retries = 0;
      const MAX_RETRIES = 5;
      let done = false;
      while (!done && retries <= MAX_RETRIES) {
        try {
          const result = await model.embedContent(payload);
          const vector = result.embedding.values;

          product.embedding = vector;
          await product.save();

          successCount++;
          if (successCount % 10 === 0) {
            console.log(`   [${index + 1}/${products.length}] Vectors updated...`);
          }
          done = true;
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        } catch (err) {
          if (err.message.includes("429")) {
            retries++;
            const waitTime = 1000 * retries;
            console.log(`  [WARN] Rate limit on "${product.title.substring(0, 30)}" (attempt ${retries}). Waiting ${waitTime / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            errorCount++;
            console.error(`[ERROR] Error on "${product.title.substring(0, 15)}...":`, err.message);
            done = true;
          }
        }
      }
      if (!done) {
        errorCount++;
        console.error(`[ERROR] Gave up on "${product.title.substring(0, 30)}" after ${MAX_RETRIES} retries`);
      }
    }

    console.log(`\n[INFO] Operation completed.`);
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);

    process.exit(0);

  } catch (error) {
    console.error("Critical Script Failure:", error);
    process.exit(1);
  }
};

vectorizeProducts();

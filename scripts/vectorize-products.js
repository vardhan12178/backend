import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";

dotenv.config();

// CHANGE 1: Super fast speed for Paid Tier
const BATCH_DELAY = 100;
const EMBEDDING_MODEL = "text-embedding-004";

if (!process.env.GEMINI_API_KEY || !process.env.MONGO_URI) {
  console.error("Error: Missing GEMINI_API_KEY or MONGO_URL.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

const vectorizeProducts = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("[INFO] MongoDB Connected.");

    // CHANGE 2: Fetch ALL products (removed 'isActive: true' just in case)
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

      try {
        const result = await model.embedContent(textToEmbed);
        const vector = result.embedding.values;

        product.embedding = vector;
        await product.save();

        successCount++;
        // Log progress every 10 items to keep console clean
        if (successCount % 10 === 0) {
          console.log(`   [${index + 1}/${products.length}] Vectors updated...`);
        }

        // Fast delay
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));

      } catch (err) {
        errorCount++;
        console.error(`[ERROR] Error on "${product.title.substring(0, 15)}...":`, err.message);
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
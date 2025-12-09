import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js"; 

dotenv.config();

const BATCH_DELAY = 1000; 
const EMBEDDING_MODEL = "text-embedding-004"; 

if (!process.env.GEMINI_API_KEY || !process.env.MONGO_URI) {
  console.error("Error: Missing GEMINI_API_KEY or MONGO_URL in environment variables.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

const vectorizeProducts = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const products = await Product.find({ isActive: true });
    console.log(`Found ${products.length} active products to process.`);

    let successCount = 0;
    let errorCount = 0;

    for (const [index, product] of products.entries()) {
      const textToEmbed = `
        Title: ${product.title}
        Brand: ${product.brand || "Generic"}
        Category: ${product.category}
        Description: ${product.description}
        Tags: ${product.tags ? product.tags.join(", ") : ""}
        Price: ${product.price}
      `.trim();

      try {
        const result = await model.embedContent(textToEmbed);
        const vector = result.embedding.values;

        product.embedding = vector;
        await product.save();
        
        successCount++;
        console.log(`[${index + 1}/${products.length}] Updated: ${product.title}`);

        // Rate limiting for API stability
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));

      } catch (err) {
        errorCount++;
        console.error(`Error processing "${product.title}":`, err.message);
      }
    }

    console.log(`\nOperation completed.`);
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    
    process.exit(0);

  } catch (error) {
    console.error("Script failed:", error);
    process.exit(1);
  }
};

vectorizeProducts();
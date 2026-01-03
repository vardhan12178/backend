import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

mongoose.connect(MONGO_URI)
    .then(() => console.log("[INFO] MongoDB Connected"))
    .catch(err => { console.error(err); process.exit(1); });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const namePool = [
    "Rahul", "Priya", "Amit", "Sneha", "Vikram", "Anjali", "Karthik", "Neha",
    "Rohan", "Sanya", "Arjun", "Ishita", "Aditya", "Meera", "Siddharth", "Kavya",
    "Vihaan", "Aarav", "Diya", "Ananya", "Kabir", "Zara", "Reyansh", "Myra",
    "Vivaan", "Saira", "Aryan", "Aisha", "Dhruv", "Riya", "Ishaan", "Nisha"
];

function getRandomName() {
    return namePool[Math.floor(Math.random() * namePool.length)];
}

async function indianizeProducts() {
    try {
        const products = await Product.find({}); // You can add .limit(5) here to test first if you want

        if (products.length === 0) {
            console.log("[INFO] No products found!");
            process.exit(0);
        }

        console.log(`[INFO] Fixing ${products.length} products using Gemini 2.5 Flash...\n`);

        for (const product of products) {
            console.log(`Processing: ${product.title.substring(0, 20)}...`);

            // ---------------------------------------------------------
            // ---------------------------------------------------------
            // 2. Generate Prompt for Content Refinement
            // ---------------------------------------------------------
            const prompt = `
            You are an expert Content Manager for an Indian E-commerce Giant (VKart).
            Refine this product data to look professional, realistic, and optimized for search.

            INPUT DATA:
            Title: "${product.title}"
            Desc: "${product.description}"
            Price: ${product.price}
            Category: "${product.category || 'General'}"

            INSTRUCTIONS:
            1. **Price (Critical):** Ignore the input price currency. Estimate the **current market value** of this item in India in INR (Rupees). 
               - Example: If it's a flagship phone, use ~40000-80000. If it's a t-shirt, use ~499-999. 
               - Return ONLY the number (e.g., 1299).

            2. **Title:** Clean, descriptive, and standard format. 
               - Format: [Brand/Type] [Key Feature] [Color/Size if applicable]
               - Example: "Samsung Galaxy M34 5G (Midnight Blue, 6GB RAM, 128GB Storage)" or "Men's Slim Fit Cotton T-Shirt - Black"

            3. **Description (Amazon Style):** - Start with **one clear summary sentence** describing the product.
               - Follow with a list of **3-5 Key Features/Specs** in bullet points.
               - Focus on specs (RAM, Material, Battery, Warranty) over marketing fluff.
               - Example Format:
                 "Experience powerful performance with this high-speed smartphone designed for multitasking."
                 "• RAM: 8GB | Storage: 128GB"
                 "• Camera: 50MP Main + 8MP Ultra-wide"
                 "• Battery: 6000mAh with Fast Charging"
                 "• Display: 6.5-inch Super AMOLED (120Hz)"

            4. **Reviews:** Pick a random Indian name ("${getRandomName()}") and write a short, realistic 4 or 5-star review. usage language like "value for money", "good quality", "fast delivery".

            OUTPUT JSON ONLY:
            { 
              "price": 1299, 
              "title": "...", 
              "description": "...", 
              "reviews": [{ "reviewerName": "...", "comment": "..." }] 
            }
            `;

            let retries = 0;
            const MAX_RETRIES = 5;
            let success = false;

            while (!success && retries <= MAX_RETRIES) {
                try {
                    const result = await model.generateContent(prompt);
                    const text = result.response.text().replace(/```json|```/g, "").trim();
                    const aiData = JSON.parse(text);

                    // Backup original
                    if (!product.originalData) {
                        product.originalData = {
                            title: product.title,
                            description: product.description,
                            price: product.price
                        };
                    }

                    // Update Fields
                    if (aiData.price) product.price = aiData.price;
                    if (aiData.title) product.title = aiData.title;
                    if (aiData.description) product.description = aiData.description;

                    // Update Review
                    if (aiData.reviews && aiData.reviews.length > 0 && product.reviews.length > 0) {
                        product.reviews[0].reviewerName = aiData.reviews[0].reviewerName;
                        product.reviews[0].comment = aiData.reviews[0].comment;
                    }

                    product.isIndianized = true;
                    product.embedding = []; // Clear old vector to force re-indexing later

                    await product.save();
                    console.log(`  [SUCCESS] Done: ₹${product.price} | Title: "${product.title.substring(0, 30)}..."`);
                    success = true;

                    // Small delay to ensure rate limit compliance
                    await delay(100);

                } catch (err) {
                    if (err.message.includes("429")) {
                        retries++;
                        retries++;
                        // Exponential backoff for rate limits
                        const waitTime = 1000 * retries;
                        console.log(`  [WARN] Rate Limit (Attempt ${retries}). Waiting ${waitTime / 1000}s...`);
                        await delay(waitTime);
                    } else {
                        console.error(`  [ERROR] Error: ${err.message}`);
                        break;
                    }
                }
            }
        }

        console.log("\n[INFO] Batch complete.");
        process.exit(0);

    } catch (error) {
        console.error("Critical Error:", error);
        process.exit(1);
    }
}

indianizeProducts();
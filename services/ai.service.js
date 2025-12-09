import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is missing in .env file");
}

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Model 1: For Embeddings (Converting text to numbers)
// Must match the model used in your vectorize script (768 dimensions)
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

// Model 2: For Chat Generation (The "Personality")
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

/**
 * Searches MongoDB for products with similar meaning to the query
 * using Vector Search.
 */
async function searchProducts(query, limit = 4) {
  try {
    // 1. Convert user query to vector
    const result = await embeddingModel.embedContent(query);
    const queryVector = result.embedding.values;

    // 2. Run Aggregation Pipeline on MongoDB
    const products = await Product.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",       // Must match the Index Name in Atlas
          path: "embedding",           // Field in Product Schema
          queryVector: queryVector,
          numCandidates: 100,          // Number of nearest neighbors to scan
          limit: limit                 // Final number of results to return
        }
      },
      {
        $project: {
          _id: 1,
          title: 1,
          price: 1,
          description: 1,
          brand: 1,
          category: 1,
          thumbnail: 1,
          score: { $meta: "vectorSearchScore" } // Include similarity score
        }
      }
    ]);

    return products;
  } catch (error) {
    console.error("Vector Search Error:", error);
    return [];
  }
}

/**
 * Generates a helpful text response based on the found products
 */
async function generateSmartReply(userQuery, products) {
  const productContext = products.map((p, index) => 
    `${index + 1}. ${p.title} (${p.brand}) - ₹${p.price} \n   Details: ${p.description.substring(0, 150)}...`
  ).join("\n\n");

  const prompt = `
    You are the sales assistant for VKart.
    User Query: "${userQuery}"

    Here are the most relevant products we have in stock:
    ${productContext}

    Instructions:
    1. Direct the user to the best option(s) from the list.
    2. Explain briefly why it fits their request.
    3. Be concise (max 3 sentences).
    4. If the products don't match the query well, apologize and suggest browsing the "${products[0]?.category || 'catalog'}" section.
  `;

  try {
    const result = await chatModel.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Gemini Chat Error:", error);
    return "I found these products for you, but I'm having trouble analyzing them right now. Please take a look below!";
  }
}

/**
 * Main Orchestrator Function
 */
export async function handleChat(message) {
  try {
    if (!message) throw new Error("Empty message received");

    // Step 1: Semantic Search
    const products = await searchProducts(message);

    // Step 2: Fallback if no products found
    if (!products || products.length === 0) {
      return { 
        reply: "I couldn't find any products matching that description. Try searching for specific items like 'wireless headphones' or 'cotton shirts'.", 
        products: [] 
      };
    }

    // Step 3: Generate AI Reply
    const reply = await generateSmartReply(message, products);

    return { reply, products };

  } catch (error) {
    console.error("AI Service Error:", error);
    return { 
      reply: "I'm currently updating my database. Please use the standard search bar for now!", 
      products: [] 
    };
  }
}
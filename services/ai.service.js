import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is missing in .env file");
}

// Initialize GenAI SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

const chatModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
  }
});

/**
 * Contextual Query Refinement
 * Enhances short or vague user inputs based on session history.
 */
async function expandQuery(message, history) {
  if (history.length === 0) return message;

  const recentContext = history.slice(-4).map(m =>
    `${m.role === 'user' ? 'User' : 'System'}: ${m.content}`
  ).join('\n');

  const prompt = `
    System Role: Contextual Query Refinement.
    
    Session Context:
    ${recentContext}
    
    Current Input: "${message}"
    
    Objective: 
    If the input relies on context (e.g., "red ones", "cheaper", "specs"), rewrite it into a standalone search query. 
    If the input is already specific, return it unchanged.

    Output JSON: { "expandedQuery": "..." }
  `;

  try {
    const result = await chatModel.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());
    const expanded = parsed.expandedQuery || message;

    if (expanded !== message) {
      console.log(`[INFO] Context applied: "${message}" → "${expanded}"`);
    }
    return expanded;
  } catch (error) {
    console.error("Context processing failed:", error.message);
    return message;
  }
}

/**
 * Semantic Vector Search
 * Retrieves relevant documents from MongoDB based on vector similarity.
 * Includes a SIMILARITY THRESHOLD to filter out irrelevant garbage.
 */
async function searchProducts(query, limit = 4) {
  try {
    const result = await embeddingModel.embedContent(query);
    const queryVector = result.embedding.values;

    const products = await Product.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: queryVector,
          numCandidates: 100, // Look at 100 nearest neighbors first
          limit: limit * 2 // Fetch extra to allow for filtering
        }
      },
      {
        $addFields: {
          score: { $meta: "vectorSearchScore" } // 1. Get the accuracy score (0 to 1)
        }
      },
      {
        $match: {
          score: { $gte: 0.60 } // 2. FILTER: Ignore matches below 60% accuracy
        }
      },
      {
        $limit: limit // 3. Return only the requested number of GOOD results
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
          score: 1
        }
      }
    ]);

    return products;
  } catch (error) {
    console.error("Search Service Error:", error);
    return [];
  }
}

/**
 * Response Orchestration
 * Generates a structured JSON response for the frontend UI.
 */
async function generateSmartReply(userQuery, products, conversationHistory = []) {
  const productContext = products.map((p, index) =>
    `${index + 1}. ${p.title} (${p.brand}) - ₹${p.price}\n   ${p.description.substring(0, 120)}...`
  ).join("\n\n");

  const historyContext = conversationHistory.length > 0
    ? `Session History:\n${conversationHistory.map(msg =>
      `${msg.role === 'user' ? 'User' : 'System'}: ${msg.content}`
    ).join('\n')}\n\n`
    : '';

  const prompt = `
    You are VKart Copilot, the official digital shopping assistant.

    Directives:
    - Assist users in finding products, comparing specs, and checking prices.
    - Maintain a professional, concise, and helpful tone.
    - Focus on "Value for Money" and Indian market context (₹).
    - Do not invent product details; strictly use the provided "Available Products" data.

    ${historyContext}
    Current Query: "${userQuery}"

    Available Products:
    ${productContext}

    Required Output JSON Format:
    {
      "greeting": "Brief professional opener (optional)",
      "response": {
        "summary": "Direct answer summarizing the findings.",
        "points": ["Key feature 1", "Key feature 2"] 
      },
      "recommendation": {
        "productIndex": 1, 
        "reason": "Objective reason for this selection (e.g., best specs for price)"
      },
      "alternatives": ["Brief mention of an alternative"],
      "followUp": "Relevant question to refine the search"
    }
  `;

  try {
    const result = await chatModel.generateContent(prompt);
    const text = result.response.text();
    return JSON.parse(text);
  } catch (error) {
    console.error("Generation Service Error:", error);
    return {
      response: {
        summary: "I found some matching products. Please review the options below.",
        points: []
      },
      recommendation: null,
      followUp: "Would you like to refine your search?"
    };
  }
}

/**
 * Vectorization Utility
 * Generates embeddings for product catalog updates.
 */
export async function vectorizeProduct(product) {
  try {
    const textToEmbed = `
      Title: ${product.title}
      Brand: ${product.brand || "Generic"}
      Category: ${product.category}
      Description: ${product.description}
      Tags: ${product.tags ? product.tags.join(", ") : ""}
      Price: ${product.price}
    `.trim();

    const result = await embeddingModel.embedContent(textToEmbed);
    product.embedding = result.embedding.values;
    await product.save();
    console.log(`[INFO] Index updated: ${product.title}`);
    return true;
  } catch (error) {
    console.error(`[ERROR] Indexing failed for ${product._id}:`, error.message);
    return false;
  }
}

/**
 * Main Chat Controller
 */
export async function handleChat(message, history = []) {
  try {
    if (!message) throw new Error("Empty message received");

    // Check for greetings or non-product queries
    const greetingPatterns = /^(h+i+|hello|hey+|hola|greetings|namaste|sup|wassup|thanks|thank\s*you|ty|bye|good\s*(morning|afternoon|evening)|ok(?:ay)?|cool|awesome|nice|help)[\s.!?]*$/i;

    if (greetingPatterns.test(message.trim())) {
      console.log(`[INFO] Greeting detected`);
      return {
        structured: {
          // Response without greeting key to avoid special UI handling
          response: {
            summary: "Hello! Welcome to VKart. I'm your digital shopping assistant. I can help you find products, compare specs, and check prices.",
            points: ["Try 'Best gaming laptop'", "Or 'Running shoes under 2000'"]
          },
          followUp: "What are you looking for today?"
        },
        products: []
      };
    }

    // 1. Expand query using conversation history
    const expandedMessage = await expandQuery(message, history);

    // 2. Perform vector search
    let products = await searchProducts(expandedMessage);

    // Handle empty results
    if (!products || products.length === 0) {
      return {
        structured: {
          response: {
            summary: "I couldn't find any products matching that specific description.",
            points: ["Try using broader keywords", "Check our main categories"]
          },
          followUp: "Can I help you find something else?"
        },
        products: []
      };
    }

    // 3. Generate AI response
    let structured = await generateSmartReply(message, products, history);

    // Re-sort products to ensure the best match is first
    // This aligns the AI's recommendation with the product list order
    if (structured.recommendation && structured.recommendation.productIndex) {
      const recommendedIndex = structured.recommendation.productIndex - 1; // Convert 1-based to 0-based

      // Check if the index is valid and not already at the top
      if (recommendedIndex > 0 && recommendedIndex < products.length) {
        console.log(`[INFO] Re-sorting: Moving item ${recommendedIndex} to top.`);

        // Remove the item from its current spot
        const [bestMatchItem] = products.splice(recommendedIndex, 1);

        // Put it at the very beginning
        products.unshift(bestMatchItem);

        // Update the AI response to point to Index 1 (since it's now first)
        structured.recommendation.productIndex = 1;
      }
    }

    return { structured, products };

  } catch (error) {
    console.error("Service Error:", error);
    return {
      structured: {
        response: {
          summary: "I am experiencing high traffic. Please use the standard search bar temporarily.",
          points: []
        }
      },
      products: []
    };
  }
}
import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is missing in .env file");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

const chatModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
  }
});

// --- Timeout helper ---
const AI_TIMEOUT_MS = 10000;

function withTimeout(promise, ms = AI_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("AI request timed out")), ms)),
  ]);
}

// --- Circuit breaker ---
const circuit = { failures: 0, lastFailure: 0, threshold: 3, resetMs: 60000 };

function isCircuitOpen() {
  if (circuit.failures >= circuit.threshold) {
    if (Date.now() - circuit.lastFailure < circuit.resetMs) return true;
    circuit.failures = 0; // reset after cooldown
  }
  return false;
}

function recordFailure() {
  circuit.failures++;
  circuit.lastFailure = Date.now();
}

function recordSuccess() {
  circuit.failures = 0;
}

const FALLBACK_RESPONSE = {
  structured: {
    response: {
      summary: "AI assistant is temporarily unavailable. Please use the search bar instead.",
      points: []
    },
    followUp: "Try again in a minute."
  },
  products: []
};

/**
 * Refines vague queries using conversation history.
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
    const result = await withTimeout(chatModel.generateContent(prompt));
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
 * Vector search against MongoDB.
 */
async function searchProducts(query, limit = 4) {
  try {
    const result = await withTimeout(embeddingModel.embedContent(query));
    const queryVector = result.embedding.values;

    const products = await Product.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: queryVector,
          numCandidates: 100,
          limit: limit * 2
        }
      },
      {
        $addFields: {
          score: { $meta: "vectorSearchScore" }
        }
      },
      {
        $match: {
          score: { $gte: 0.60 }
        }
      },
      {
        $limit: limit
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
 * Generates a structured JSON response for the frontend.
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
    const result = await withTimeout(chatModel.generateContent(prompt));
    const text = result.response.text();
    return JSON.parse(text);
  } catch (error) {
    console.error("Generation error:", error);
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
 * Generates embeddings for a product document.
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
 * Main chat handler with circuit breaker.
 */
export async function handleChat(message, history = []) {
  try {
    if (!message) throw new Error("Empty message received");

    if (isCircuitOpen()) {
      console.warn("[WARN] AI circuit breaker is open, returning fallback");
      return FALLBACK_RESPONSE;
    }

    const greetingPatterns = /^(h+i+|hello|hey+|hola|greetings|namaste|sup|wassup|thanks|thank\s*you|ty|bye|good\s*(morning|afternoon|evening)|ok(?:ay)?|cool|awesome|nice|help)[\s.!?]*$/i;

    if (greetingPatterns.test(message.trim())) {
      return {
        structured: {
          response: {
            summary: "Hello! Welcome to VKart. I'm your digital shopping assistant. I can help you find products, compare specs, and check prices.",
            points: ["Try 'Best gaming laptop'", "Or 'Running shoes under 2000'"]
          },
          followUp: "What are you looking for today?"
        },
        products: []
      };
    }

    const expandedMessage = await expandQuery(message, history);

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

    // Generate AI response
    let structured = await generateSmartReply(message, products, history);

    // Reorder products so the recommended item is first
    if (structured.recommendation && structured.recommendation.productIndex) {
      const recommendedIndex = structured.recommendation.productIndex - 1;

      if (recommendedIndex > 0 && recommendedIndex < products.length) {
        const [bestMatchItem] = products.splice(recommendedIndex, 1);
        products.unshift(bestMatchItem);
        structured.recommendation.productIndex = 1;
      }
    }

    recordSuccess();
    return { structured, products };

  } catch (error) {
    console.error("Chat error:", error.message);
    recordFailure();
    return FALLBACK_RESPONSE;
  }
}
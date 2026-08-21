import { GoogleGenerativeAI } from "@google/generative-ai";
import Product from "../models/Product.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is missing in .env file");
}

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 768);
const VECTOR_MIN_SCORE = Number(process.env.AI_VECTOR_MIN_SCORE || 0.60);
const VECTOR_NUM_CANDIDATES = Number(process.env.AI_VECTOR_CANDIDATES || 150);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const embeddingModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

// Using the "lite" alias rather than a pinned version: gemini-2.5-flash has
// only a 20 requests/day free-tier cap (shared across chat, query expansion,
// review summaries, and search parsing - was getting exhausted fast), and
// lite-tier models carry a materially higher free daily quota by design.
// The "-latest" alias also avoids re-breaking when Google deprecates a
// specific pinned version (already happened once this session to
// gemini-2.0-flash-lite/gemini-2.5-flash-lite).
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-flash-lite-latest";
const chatModel = genAI.getGenerativeModel({
  model: CHAT_MODEL,
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

const PRODUCT_PROJECTION = {
  _id: 1,
  title: 1,
  price: 1,
  description: 1,
  brand: 1,
  category: 1,
  thumbnail: 1,
  stock: 1
};

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function embedText(text) {
  const payload = {
    content: { parts: [{ text: String(text || "").trim() }] },
  };

  if (Number.isFinite(EMBEDDING_DIM) && EMBEDDING_DIM > 0) {
    payload.outputDimensionality = EMBEDDING_DIM;
  }

  const result = await withTimeout(embeddingModel.embedContent(payload));
  const vector = result?.embedding?.values;

  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding generation returned an empty vector");
  }

  return vector;
}

async function keywordFallbackSearch(query, limit = 4) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return [];

  try {
    const textMatches = await Product.find(
      { isActive: true, stock: { $gt: 0 }, $text: { $search: cleaned } },
      { ...PRODUCT_PROJECTION, score: { $meta: "textScore" } }
    )
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .lean();

    if (textMatches.length) {
      return textMatches;
    }
  } catch (error) {
    // If text index is unavailable, fallback to regex search below.
    console.warn("Keyword fallback (text index) failed:", error.message);
  }

  const rx = new RegExp(escapeRegex(cleaned), "i");

  return Product.find({
    isActive: true,
    stock: { $gt: 0 },
    $or: [{ title: rx }, { description: rx }, { category: rx }, { brand: rx }]
  })
    .select(PRODUCT_PROJECTION)
    .limit(limit)
    .lean();
}

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
    const queryVector = await embedText(query);
    const safeLimit = Math.max(1, Number(limit) || 4);
    const numCandidates = Math.max(VECTOR_NUM_CANDIDATES, safeLimit * 10);

    const products = await Product.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: queryVector,
          numCandidates: numCandidates,
          limit: safeLimit * 3
        }
      },
      {
        $addFields: {
          score: { $meta: "vectorSearchScore" }
        }
      },
      {
        $match: {
          isActive: true,
          stock: { $gt: 0 },
          score: { $gte: VECTOR_MIN_SCORE }
        }
      },
      {
        $limit: safeLimit
      },
      {
        $project: {
          ...PRODUCT_PROJECTION,
          score: 1
        }
      }
    ]);

    if (products.length > 0) {
      return products;
    }

    return keywordFallbackSearch(query, safeLimit);
  } catch (error) {
    console.error("Search Service Error:", error.message);
    return keywordFallbackSearch(query, limit);
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
 * Summarizes a product's reviews into structured pros/cons via Gemini.
 * Grounded strictly in the supplied review text - reviewsAnalyzed is set
 * from the actual array length server-side, never trusted from the model.
 */
export async function generateReviewSummary(product, reviews) {
  const sample = reviews.slice(0, 40);
  const reviewText = sample
    .map((r, i) => `${i + 1}. [${r.rating}/5] ${(r.comment || "").slice(0, 300)}`)
    .join("\n");

  const prompt = `
    You are summarizing real customer reviews for an Indian e-commerce product.

    Product: ${product.title} (${product.category})

    Directives:
    - Base every point strictly on the reviews below. Do not invent details not present in the reviews.
    - If reviews disagree, reflect that in "sentiment" (use "mixed").
    - Keep each pro/con to a short phrase, not a full sentence.

    Reviews (${sample.length} of ${reviews.length} total):
    ${reviewText}

    Required Output JSON Format:
    {
      "sentiment": "positive" | "mixed" | "negative",
      "pros": ["short phrase", "..."],
      "cons": ["short phrase", "..."],
      "bestFor": "One short sentence on who this product suits, based only on the reviews."
    }
  `;

  const result = await withTimeout(chatModel.generateContent(prompt));
  const parsed = JSON.parse(result.response.text());

  return {
    sentiment: ["positive", "mixed", "negative"].includes(parsed.sentiment) ? parsed.sentiment : "mixed",
    pros: Array.isArray(parsed.pros) ? parsed.pros.slice(0, 5) : [],
    cons: Array.isArray(parsed.cons) ? parsed.cons.slice(0, 5) : [],
    bestFor: typeof parsed.bestFor === "string" ? parsed.bestFor : "",
    reviewsAnalyzed: reviews.length,
  };
}

/**
 * Generates an AI verdict for a 2-4 product comparison: an overall pick plus
 * a short "best for" reasoning per product where there's a real
 * differentiator. Grounded strictly on the products' own stored fields
 * (price/rating/brand/description) — never invents a spec not present.
 */
export async function generateComparisonSummary(products) {
  const productBlocks = products
    .map(
      (p, i) => `
    Product ${i + 1} (id: ${p._id}):
      Title: ${p.title}
      Brand: ${p.brand || "Generic"}
      Category: ${p.category}
      Price: ₹${p.price}
      Rating: ${p.rating ?? "N/A"} (${p.reviews?.length || 0} reviews)
      Description: ${(p.description || "").slice(0, 500)}
  `
    )
    .join("\n");

  const prompt = `
    You are an impartial shopping assistant comparing products for an Indian e-commerce store.

    ${productBlocks}

    Directives:
    - Base every claim strictly on the fields given above. Do not invent specs, features, or
      comparisons not supported by this data.
    - "overallPickId" must be one of the exact product ids listed above.
    - Every product must get a short "bestFor" line — if two products don't clearly differ,
      it's fine for the reasoning to be about price/rating rather than invented features.
    - Keep bestFor to one short sentence each. Keep the overall reason to 1-2 sentences.

    Required Output JSON Format:
    {
      "overallPickId": "the id of the best overall pick",
      "overallReason": "1-2 sentences on why, grounded in the data above",
      "perProduct": [
        { "id": "product id", "bestFor": "one short sentence" }
      ]
    }
  `;

  const result = await withTimeout(chatModel.generateContent(prompt));
  const parsed = JSON.parse(result.response.text());

  const validIds = new Set(products.map((p) => String(p._id)));
  const perProduct = Array.isArray(parsed.perProduct)
    ? parsed.perProduct
        .filter((row) => row && validIds.has(String(row.id)))
        .map((row) => ({ id: String(row.id), bestFor: typeof row.bestFor === "string" ? row.bestFor : "" }))
    : [];

  return {
    overallPickId: validIds.has(String(parsed.overallPickId)) ? String(parsed.overallPickId) : null,
    overallReason: typeof parsed.overallReason === "string" ? parsed.overallReason : "",
    perProduct,
  };
}

const SORT_VALUES = new Set(["price_asc", "price_desc", "rating_desc", "newest"]);

/**
 * Parses a free-text search query into structured filters matching the
 * exact params getProducts() already accepts. Grounded against the real
 * category list so the model can't invent a category that doesn't exist.
 * Every field is validated/clamped server-side before returning.
 */
export async function parseSearchQuery(nlQuery, categories) {
  const prompt = `
    You are a search-query parser for an Indian e-commerce store (prices in INR, ₹).

    Valid categories (choose exactly one of these, or null if none clearly match):
    ${categories.join(", ")}

    User query: "${nlQuery}"

    Extract structured search filters. Only include a value if the user's text actually implies it -
    do not guess a price range or rating if the user didn't mention one.

    Required Output JSON Format:
    {
      "q": "residual free-text keywords to still search on (brand/product terms), or empty string",
      "category": "<one value from the valid categories list, or null>",
      "minPrice": number or null,
      "maxPrice": number or null,
      "minRating": number (1-5) or null,
      "sort": "price_asc" | "price_desc" | "rating_desc" | "newest" | null
    }
  `;

  const result = await withTimeout(chatModel.generateContent(prompt));
  const parsed = JSON.parse(result.response.text());

  const category = typeof parsed.category === "string" && categories.includes(parsed.category)
    ? parsed.category
    : null;
  const sort = SORT_VALUES.has(parsed.sort) ? parsed.sort : null;
  const clampRating = (n) => (Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : null);
  const positiveOrNull = (n) => (Number.isFinite(n) && n >= 0 ? n : null);

  return {
    q: typeof parsed.q === "string" ? parsed.q.trim() : "",
    category,
    minPrice: positiveOrNull(Number(parsed.minPrice)),
    maxPrice: positiveOrNull(Number(parsed.maxPrice)),
    minRating: clampRating(Number(parsed.minRating)),
    sort,
  };
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

    product.embedding = await embedText(textToEmbed);
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

import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";
import redis from "../utils/redis.js";
import { chatTurn, rankStoredTurn } from "./aiSearch.js";
import { getActiveSale } from "../controllers/sale.controller.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is missing in .env file");
}

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 768);

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

async function embedText(text, taskType) {
  const payload = {
    content: { parts: [{ text: String(text || "").trim() }] },
    ...(taskType ? { taskType } : {}),
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

const SORT_VALUES = new Set(["price_asc", "price_desc", "rating_desc", "newest"]);

/**
 * Parses a free-text search query into the listing's filters. Grounded against the storefront
 * categories ([{ slug, name }]) so the model can't invent one; every field is validated before returning.
 */
export async function parseSearchQuery(nlQuery, categories) {
  const slugs = categories.map((c) => c.slug);
  const prompt = `
    You are a search-query parser for an Indian e-commerce store (prices in INR, ₹).

    Valid categories (answer with the slug before the colon, or null if none clearly match):
    ${categories.map((c) => `${c.slug}: ${c.name}`).join("\n    ")}

    User query: "${nlQuery}"

    Extract structured search filters. Only include a value if the user's text actually implies it -
    do not guess a price range or rating if the user didn't mention one.

    Required Output JSON Format:
    {
      "q": "residual free-text keywords to still search on (brand/product terms), or empty string",
      "category": "<one slug from the valid categories list, or null>",
      "minPrice": number or null,
      "maxPrice": number or null,
      "minRating": number (1-5) or null,
      "sort": "price_asc" | "price_desc" | "rating_desc" | "newest" | null
    }
  `;

  const result = await withTimeout(chatModel.generateContent(prompt));
  const parsed = JSON.parse(result.response.text());

  const category = typeof parsed.category === "string" && slugs.includes(parsed.category)
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

// Model calls for the catalog chat (services/aiSearch.js). Catalog documents were
// embedded as RETRIEVAL_DOCUMENT, so queries use the matching RETRIEVAL_QUERY task type.
// The intent and answer calls are short JSON tasks and should not spend time "thinking".
// Gemini 3 models (e.g. gemini-3.5-flash-lite) already default to minimal thinking and reject the
// 2.5-era thinkingBudget field, so it is only sent to 2.5 models. AI_V2_MODEL picks a different
// model for these calls; AI_V2_TIMEOUT_MS bounds each one.
const SEARCH_MODEL = process.env.AI_V2_MODEL || CHAT_MODEL;
const SEARCH_TIMEOUT_MS = Number(process.env.AI_V2_TIMEOUT_MS || 7000);
// AI_V2_THINKING_LEVEL ("minimal" | "low" | ...) sets thinkingConfig.thinkingLevel for Gemini 3 models.
const SEARCH_THINKING_LEVEL = process.env.AI_V2_THINKING_LEVEL || "";
const fastModel = (thinking) => genAI.getGenerativeModel({
  model: SEARCH_MODEL,
  generationConfig: {
    responseMimeType: "application/json",
    temperature: 0.2,
    ...(!thinking ? { thinkingConfig: { thinkingBudget: 0 } } : SEARCH_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: SEARCH_THINKING_LEVEL } } : {}),
  },
});
let thinkingOffSupported = /gemini-2\.5/.test(SEARCH_MODEL);
let fast = fastModel(!thinkingOffSupported);

// Runs one call and logs how long Gemini really took, including calls we stopped waiting for,
// plus token usage (thoughtsTokenCount shows whether the model spent time thinking).
async function timedCall(prompt, label, timeoutMs = SEARCH_TIMEOUT_MS) {
  const started = Date.now();
  const call = fast.generateContent(prompt);
  call
    .then((r) => {
      const u = r.response?.usageMetadata || {};
      console.log(`[aiSearch] gemini ${label} ${SEARCH_MODEL} ${Date.now() - started}ms`, JSON.stringify({
        prompt: u.promptTokenCount, output: u.candidatesTokenCount, thoughts: u.thoughtsTokenCount,
        finish: r.response?.candidates?.[0]?.finishReason,
      }));
    })
    .catch((err) => console.warn(`[aiSearch] gemini ${label} ${SEARCH_MODEL} failed after ${Date.now() - started}ms: ${err.message}`));
  return JSON.parse((await withTimeout(call, timeoutMs)).response.text());
}

async function jsonCall(prompt, label, timeoutMs) {
  try {
    return await timedCall(prompt, label, timeoutMs);
  } catch (err) {
    // Some models reject thinkingConfig with a bare "400 ... invalid argument"; drop it once and keep going
    if (thinkingOffSupported && /\b400\b|invalid argument|thinking/i.test(err.message)) {
      console.warn(`[aiSearch] ${SEARCH_MODEL} rejected thinkingConfig; retrying without it`);
      thinkingOffSupported = false;
      fast = fastModel(true);
      return timedCall(prompt, label, timeoutMs);
    }
    throw err;
  }
}

const searchAi = {
  intent: (prompt) => jsonCall(prompt, "intent"),
  answer: (prompt, opts = {}) => jsonCall(prompt, "answer", opts.timeoutMs),
  embed: (text) => withTimeout(embedText(text, "RETRIEVAL_QUERY"), SEARCH_TIMEOUT_MS),
};

// Phase-two state for two-phase answers: the rerank pool, kept in Redis for 10 minutes.
// The phase-two call may wait longer for the model (AI_V2_RANK_TIMEOUT_MS) because results are already shown.
const RANK_TTL_S = 600;
const RANK_TIMEOUT_MS = Number(process.env.AI_V2_RANK_TIMEOUT_MS || 25000);
const rankStore = {
  save: async (data) => {
    const token = crypto.randomUUID();
    await redis.set(`ai:rank:${token}`, JSON.stringify(data), "EX", RANK_TTL_S);
    return token;
  },
  load: async (token) => {
    const raw = await redis.get(`ai:rank:${token}`);
    return raw ? JSON.parse(raw) : null;
  },
};

/** Phase two of a two-phase answer: model picks and reasons, or null when the token is unknown. */
export async function rankChat(token) {
  return rankStoredTurn(token, searchAi, rankStore, { timeoutMs: RANK_TIMEOUT_MS, sale: await getActiveSale() });
}

/** Main chat handler with circuit breaker. `twoPhase` returns results first and the model's picks via rankChat. */
export async function handleChat(message, history = [], { twoPhase = false } = {}) {
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

    const sale = await getActiveSale();
    const result = await chatTurn(message, history, searchAi, twoPhase ? { store: rankStore, sale } : { sale });
    recordSuccess();
    return { structured: result.structured, products: result.products, ...(result.rank ? { rank: result.rank } : {}) };
  } catch (error) {
    console.error("Chat error:", error.message);
    recordFailure();
    return FALLBACK_RESPONSE;
  }
}

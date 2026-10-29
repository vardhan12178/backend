import { GoogleGenerativeAI } from "@google/generative-ai";
import CatalogProduct from "../models/CatalogProduct.js";
import { intentPrompt, answerPrompt, sanitizeIntent, applyRanking } from "./aiSearchV2.js";

// One-off model comparison for Ask VKart, run on the real server with the real API key.
// Enable with AI_MODEL_PROBE=1 (default candidates) or a comma-separated model list, restart,
// read the "[modelProbe]" log lines, then remove the variable. Each candidate gets the real
// intent and rerank prompts twice; models run in parallel, calls per model run one after another.

const DEFAULT_CANDIDATES = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];
const CALL_TIMEOUT_MS = 60000;
const ROUNDS = 2;

const SAMPLE_MESSAGE = "gaming phone under 40k with big battery";

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);
}

async function samplePool() {
  return CatalogProduct.find({ category: "mobiles", inStock: true, "priceRange.min": { $lte: 40000 } })
    .select({ embedding: 0, specs: 0, description: 0, source: 0, variantOptions: 0 })
    .sort({ "keySpecs.batteryMah": -1 })
    .limit(10)
    .lean();
}

async function probeModel(genAI, model, pool) {
  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (const task of ["intent", "answer"]) {
      const prompt = task === "intent" ? intentPrompt(SAMPLE_MESSAGE, []) : answerPrompt(SAMPLE_MESSAGE, pool, []);
      const m = genAI.getGenerativeModel({ model, generationConfig: { responseMimeType: "application/json" } });
      const started = Date.now();
      try {
        const r = await withTimeout(m.generateContent(prompt), CALL_TIMEOUT_MS);
        const ms = Date.now() - started;
        const u = r.response.usageMetadata || {};
        let quality;
        try {
          const json = JSON.parse(r.response.text());
          if (task === "intent") {
            const intent = sanitizeIntent(json, SAMPLE_MESSAGE);
            quality = `category=${intent.category} maxPrice=${intent.maxPrice} minBatteryMah=${intent.minBatteryMah}`;
          } else {
            const ranked = applyRanking(pool, json);
            quality = `reranked=${ranked.reranked} picks=${ranked.items.map((it) => it.doc.slug).join("|")} reasons=${ranked.items.filter((it) => it.reason).length}`;
          }
        } catch {
          quality = "INVALID JSON";
        }
        results.push({ task, ms, ok: true });
        console.log(`[modelProbe] ${model} ${task} round ${round}: ${ms}ms tokens in/out/thoughts ${u.promptTokenCount}/${u.candidatesTokenCount}/${u.thoughtsTokenCount ?? 0} ${quality}`);
      } catch (err) {
        const ms = Date.now() - started;
        results.push({ task, ms, ok: false });
        console.log(`[modelProbe] ${model} ${task} round ${round}: FAILED after ${ms}ms: ${String(err.message).slice(0, 200)}`);
        if (/404|not found|not supported/i.test(err.message)) return { model, results, missing: true };
      }
    }
  }
  return { model, results };
}

export async function runModelProbe(setting) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const models = setting && setting !== "1" && setting !== "true"
    ? setting.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CANDIDATES;
  const pool = await samplePool();
  console.log(`[modelProbe] starting: ${models.length} models, ${ROUNDS} rounds, ${pool.length} candidate products`);

  const all = await Promise.all(models.map((m) => probeModel(genAI, m, pool).catch((err) => ({ model: m, results: [], error: err.message }))));
  for (const r of all) {
    const ok = r.results.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
    const median = ok.length ? ok[Math.floor(ok.length / 2)] : null;
    console.log(`[modelProbe] SUMMARY ${r.model}: ${r.missing ? "model not available" : `${ok.length}/${r.results.length} ok, median ${median ?? "-"}ms, max ${ok.length ? ok[ok.length - 1] : "-"}ms`}`);
  }
}

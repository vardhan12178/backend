import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { hybridSearch, sanitizeIntent, MAX_RESULTS } from "../../services/aiSearchV2.js";

// Retrieval quality for the catalog v2 Ask VKart search (AI_UPGRADE_PLAN.md, phase 0).
//
//   node scripts/catalog-v2/eval-search.js [--mode=all|keyword|vector|hybrid] [--verbose]
//
// Each case in tests/fixtures/catalog-v2-search-eval.json gives a query, the filters the intent
// step should extract, and the products that count as a correct answer. Prints, per mode:
//   Recall@4 - share of cases with at least one expected product in the top 4
//   MRR      - mean of 1 / rank of the first expected product (0 when none in the top 10)
// Needs MONGO_URI, GEMINI_API_KEY and the Atlas index catalog_v2_vector.

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(fs.readFileSync(path.join(here, "../../tests/fixtures/catalog-v2-search-eval.json"), "utf8"));
const args = process.argv.slice(2);
const modeArg = args.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";
const MODES = modeArg === "all" ? ["keyword", "vector", "hybrid"] : [modeArg];
const verbose = args.includes("--verbose");

const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001" });
const cache = new Map();
async function embed(text) {
  if (!cache.has(text)) {
    const r = await model.embedContent({ content: { parts: [{ text }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: Number(process.env.EMBEDDING_DIM || 768) });
    cache.set(text, r.embedding.values);
  }
  return cache.get(text);
}

async function main() {
  if (!process.env.MONGO_URI || !process.env.GEMINI_API_KEY) {
    console.error("Error: Missing MONGO_URI or GEMINI_API_KEY.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const rows = [];
  for (const mode of MODES) {
    let hits = 0;
    let rr = 0;
    const byType = {};
    for (const c of CASES) {
      const intent = sanitizeIntent({ query: c.query, ...(c.filters || {}) }, c.query);
      const { products } = await hybridSearch(intent, { embed, mode });
      const slugs = products.map((p) => p.slug);
      const rank = slugs.findIndex((s) => c.expected.includes(s)) + 1;
      const hit = rank > 0 && rank <= MAX_RESULTS;
      hits += hit ? 1 : 0;
      rr += rank > 0 ? 1 / rank : 0;
      byType[c.type] = byType[c.type] || { n: 0, hits: 0 };
      byType[c.type].n += 1;
      byType[c.type].hits += hit ? 1 : 0;
      if (verbose) console.log(`${mode.padEnd(7)} ${hit ? "✓" : "✗"} rank ${rank || "-"}  ${c.query}  →  ${slugs.slice(0, 4).join(", ")}`);
    }
    rows.push({
      mode,
      "Recall@4": `${((hits / CASES.length) * 100).toFixed(1)}%`,
      MRR: (rr / CASES.length).toFixed(3),
      ...Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, `${v.hits}/${v.n}`])),
    });
  }
  console.log(`\n${CASES.length} cases`);
  console.table(rows);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});

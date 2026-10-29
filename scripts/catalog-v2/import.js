import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import CatalogProduct from "../../models/CatalogProduct.js";
import { loadProducts, validateCatalog, withStock, derive, buildSearchText, contentHash } from "./lib.js";

// Imports data/catalog-v2/*/*.json into the catalog_products collection.
//
//   node scripts/catalog-v2/import.js [--dry-run] [--no-embed] [--force] [--category=mobiles] [--status=active]
//
// --dry-run   validate and print what would change, write nothing
// --no-embed  upsert documents without calling Gemini (embeddings can be filled on a later run)
// --force     re-import and re-embed even when the content hash is unchanged
// --status    override the status stored in the files (they are all "draft")
//
// Safe to re-run: unchanged products (same content hash, embedding present) are skipped.
// Run scripts/catalog-v2/images.js first so media items carry S3 keys instead of the brands' URLs.

dotenv.config();

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 768);
const DEFAULT_STOCK = Number(process.env.CATALOG_DEFAULT_STOCK || 50);
const BATCH_DELAY = 100;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeEmbedder(apiKey = process.env.GEMINI_API_KEY) {
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: EMBEDDING_MODEL });
  return async (text) => {
    const payload = { content: { parts: [{ text }] }, taskType: "RETRIEVAL_DOCUMENT" };
    if (Number.isFinite(EMBEDDING_DIM) && EMBEDDING_DIM > 0) payload.outputDimensionality = EMBEDDING_DIM;
    for (let attempt = 0; ; attempt++) {
      try {
        const vector = (await model.embedContent(payload))?.embedding?.values;
        if (!Array.isArray(vector) || !vector.length) throw new Error("empty embedding");
        return vector;
      } catch (err) {
        if (!String(err.message).includes("429") || attempt >= MAX_RETRIES) throw err;
        await sleep(1000 * (attempt + 1));
      }
    }
  };
}

/**
 * Upserts every catalog file. `embed` is injected so tests can run without Gemini.
 * Returns counts: { created, updated, skipped, embedded, failed }.
 */
export async function runImport({ entries, embed = null, dryRun = false, force = false, status = null, log = console.log }) {
  const stats = { created: 0, updated: 0, skipped: 0, embedded: 0, failed: 0 };
  const existing = new Map(
    (await CatalogProduct.find({}, { slug: 1, contentHash: 1, searchText: 1, embeddingUpdatedAt: 1 }).lean()).map((p) => [p.slug, p])
  );

  for (const { file, doc: raw } of entries) {
    const doc = withStock(status ? { ...raw, status } : raw, DEFAULT_STOCK);
    const hash = contentHash(doc);
    const prev = existing.get(doc.slug);
    const searchText = buildSearchText(doc);
    // Only the search text is embedded, so image or stock changes don't cost a Gemini call.
    const needsEmbed = embed && (force || !prev?.embeddingUpdatedAt || prev.searchText !== searchText);

    if (prev && prev.contentHash === hash && !force && !needsEmbed) {
      stats.skipped++;
      continue;
    }
    if (dryRun) {
      log(`[dry-run] ${prev ? "update" : "create"} ${doc.slug}`);
      stats[prev ? "updated" : "created"]++;
      continue;
    }

    const update = { ...doc, ...derive(doc), searchText, contentHash: hash };
    try {
      if (needsEmbed) {
        update.embedding = await embed(update.searchText);
        update.embeddingUpdatedAt = new Date();
        stats.embedded++;
        await sleep(embed.delay ?? BATCH_DELAY);
      }
      await CatalogProduct.updateOne({ slug: doc.slug }, { $set: update }, { upsert: true, runValidators: true });
      stats[prev ? "updated" : "created"]++;
    } catch (err) {
      stats.failed++;
      log(`[ERROR] ${file}: ${err.message}`);
    }
  }
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const dryRun = flag("dry-run");
  const noEmbed = flag("no-embed");

  const entries = loadProducts(undefined, { category: value("category") });
  const errors = validateCatalog(entries);
  if (errors.length) {
    console.error(`[ERROR] ${errors.length} validation error(s):\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[INFO] ${entries.length} product files valid.`);

  if (!process.env.MONGO_URI) {
    console.error("Error: Missing MONGO_URI.");
    process.exit(1);
  }
  if (!noEmbed && !dryRun && !process.env.GEMINI_API_KEY) {
    console.error("Error: Missing GEMINI_API_KEY (or pass --no-embed).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected.");
  await CatalogProduct.syncIndexes();

  const stats = await runImport({
    entries,
    embed: noEmbed || dryRun ? null : makeEmbedder(),
    dryRun,
    force: flag("force"),
    status: value("status") || null,
  });
  console.log("[INFO] Done.", stats);
  await mongoose.disconnect();
  process.exit(stats.failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Critical Script Failure:", err);
    process.exit(1);
  });
}

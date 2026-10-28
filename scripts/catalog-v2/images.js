import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import sharp from "sharp";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../../utils/s3.js";
import { DATA_DIR, loadProducts } from "./lib.js";

// Moves catalog v2 images from the brands' sites to S3 (CATALOG_V2_SCHEMA.md §5).
//
//   node scripts/catalog-v2/images.js [--dry-run] [--category=mobiles] [--limit=10] [--out=./tmp-images]
//
// For each image that still has a `src` URL:
//   1. download it once
//   2. skip it if the long edge is under MIN_IMAGE_EDGE px (default 1000), unless that would leave the product with no images
//   3. convert to WebP: thumb 300 px, md 800 px, lg 1600 px (never enlarged)
//   4. upload to s3://$S3_BUCKET/catalog-v2/{key}-{size}.webp
//   5. rewrite the item in the JSON file as { key, alt, sourceUrl, width, height }
//
// Each product file is saved as soon as its images are done, so the script can be stopped and re-run:
// items that already have a `key` are skipped.
// --out writes the WebP files to a local folder instead of S3 (for checking output without AWS access).
// --dry-run downloads and converts but writes nothing.

dotenv.config();

const BUCKET = process.env.S3_BUCKET || "vkart-assets-mumbai";
const PREFIX = "catalog-v2";
const MIN_EDGE = Number(process.env.MIN_IMAGE_EDGE || 1000);
const SIZES = { thumb: 300, md: 800, lg: 1600 };
const CONCURRENCY = 4;
const TIMEOUT_MS = 30000;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

async function download(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; VKartCatalog/1.0)", Accept: "image/avif,image/webp,image/*,*/*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function toWebp(buffer) {
  const meta = await sharp(buffer).metadata();
  const out = {};
  for (const [name, edge] of Object.entries(SIZES)) {
    out[name] = await sharp(buffer)
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  }
  return { files: out, width: meta.width, height: meta.height };
}

async function store(key, files, { outDir, dryRun }) {
  if (dryRun) return;
  for (const [size, body] of Object.entries(files)) {
    const name = `${PREFIX}/${key}-${size}.webp`;
    if (outDir) {
      fs.mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true });
      fs.writeFileSync(path.join(outDir, name), body);
    } else {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: name, Body: body, ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable", ServerSideEncryption: "AES256",
      }));
    }
  }
}

// Runs fn over items with a small worker pool.
async function pool(items, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function processProduct({ file, doc }, opts, stats) {
  const { media } = doc;
  const lists = [...Object.entries(media.groups || {}).map(([g, list]) => [slug(g), list]), ["common", media.common || []]];
  const pending = lists.flatMap(([group, list]) => list.map((item, i) => ({ group, list, i, item }))).filter((x) => x.item.src && !x.item.key);
  if (!pending.length) return false;

  const results = [];
  await pool(pending, async (p) => {
    try {
      const { files, width, height } = await toWebp(await download(p.item.src));
      results.push({ ...p, files, width, height });
    } catch (err) {
      stats.failed++;
      console.log(`[WARN] ${file}: ${p.item.src.slice(0, 90)} → ${err.message}`);
    }
  });

  const total = lists.reduce((n, [, list]) => n + list.length, 0);
  let small = results.filter((r) => Math.max(r.width, r.height) < MIN_EDGE);
  if (small.length && small.length === total) small = []; // keep low-res images rather than leave a product empty

  const drop = new Set(small.map((r) => r.item));
  for (const r of results) {
    if (drop.has(r.item)) continue;
    const key = `${doc.category}/${doc.slug}/${r.group}-${r.i + 1}`;
    await store(key, r.files, opts);
    r.list[r.i] = { key, alt: r.item.alt, sourceUrl: r.item.src, width: r.width, height: r.height };
    stats.uploaded++;
  }
  for (const [, list] of lists) {
    for (let i = list.length - 1; i >= 0; i--) if (drop.has(list[i])) list.splice(i, 1);
  }
  stats.tooSmall += drop.size;
  return results.length > 0;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const opts = { dryRun: args.includes("--dry-run"), outDir: value("out") };
  const limit = Number(value("limit") || Infinity);

  if (!opts.dryRun && !opts.outDir && (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)) {
    console.error("Error: Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or pass --out=dir or --dry-run).");
    process.exit(1);
  }

  const entries = loadProducts(undefined, { category: value("category") }).slice(0, limit);
  console.log(`[INFO] ${entries.length} products → ${opts.dryRun ? "dry run" : opts.outDir ? `local folder ${opts.outDir}` : `s3://${BUCKET}/${PREFIX}/`}`);

  const stats = { products: 0, uploaded: 0, tooSmall: 0, failed: 0 };
  for (const [n, entry] of entries.entries()) {
    const changed = await processProduct(entry, opts, stats);
    if (changed && !opts.dryRun) fs.writeFileSync(path.join(DATA_DIR, entry.file), `${JSON.stringify(entry.doc, null, 2)}\n`);
    if (changed) stats.products++;
    if ((n + 1) % 10 === 0) console.log(`   [${n + 1}/${entries.length}]`, stats);
  }
  console.log("[INFO] Done.", stats);
  process.exit(stats.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Critical Script Failure:", err);
  process.exit(1);
});

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Pincode from "../../models/Pincode.js";
import { parseCsv, normalizeRecord, aggregate } from "./lib.js";

// Loads India Post's All India Pincode Directory into the `pincodes` collection.
//
//   npm run pincodes:import -- --file=./all_india_pincode_directory.csv
//   npm run pincodes:import -- --api-key=<your data.gov.in key>     (or DATA_GOV_IN_API_KEY in .env)
//
// --file      a CSV (or JSON array) downloaded from data.gov.in
// --api-key   fetch the same directory through the data.gov.in API instead (free key from your data.gov.in account)
// --resource  data.gov.in resource id, if the directory moves
// --dry-run   parse and print a summary, write nothing
//
// Re-running replaces the collection's contents with the new directory.

dotenv.config();

const RESOURCE = "5c2f62fe-5afa-4119-a499-fec9d604d5bd"; // "All India Pincode Directory"
const PAGE = 1000;

async function fromApi(apiKey, resource) {
  const records = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `https://api.data.gov.in/resource/${resource}?api-key=${encodeURIComponent(apiKey)}&format=json&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`data.gov.in returned ${res.status} at offset ${offset}`);
    const body = await res.json();
    const page = body.records || [];
    records.push(...page);
    const total = Number(body.total) || 0;
    process.stdout.write(`\rFetched ${records.length}${total ? ` of ${total}` : ""} post offices`);
    if (page.length < PAGE || (total && records.length >= total)) break;
  }
  process.stdout.write("\n");
  return records;
}

function fromFile(file) {
  const text = fs.readFileSync(file, "utf8");
  if (/\.json$/i.test(file)) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : data.records || [];
  }
  return parseCsv(text);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dryRun = args.includes("--dry-run");
  const file = value("file");
  const apiKey = value("api-key") || process.env.DATA_GOV_IN_API_KEY;

  if (!file && !apiKey) {
    console.error("Pass --file=<directory.csv> or --api-key=<data.gov.in key> (see the header of this script).");
    process.exit(1);
  }

  const raw = file ? fromFile(path.resolve(file)) : await fromApi(apiKey, value("resource") || RESOURCE);
  const records = raw.map(normalizeRecord).filter(Boolean);
  if (!records.length) {
    console.error(`No PIN codes found in ${raw.length} rows. Columns seen: ${Object.keys(raw[0] || {}).join(", ")}`);
    process.exit(1);
  }
  const docs = aggregate(records);
  const states = new Set(docs.map((d) => d.state));
  console.log(`${raw.length} post offices -> ${docs.length} PIN codes in ${states.size} states/UTs, ${docs.filter((d) => d.location).length} with coordinates`);
  console.log("Sample:", JSON.stringify(docs.find((d) => d._id === "560038") || docs[0]));
  if (dryRun) return;

  if (!process.env.MONGO_URI) {
    console.error("Error: Missing MONGO_URI.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    for (let i = 0; i < docs.length; i += 1000) {
      await Pincode.bulkWrite(
        docs.slice(i, i + 1000).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
        { ordered: false }
      );
      process.stdout.write(`\rSaved ${Math.min(i + 1000, docs.length)} of ${docs.length}`);
    }
    process.stdout.write("\n");
    const { deletedCount } = await Pincode.deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
    console.log(`Done. Removed ${deletedCount} PIN codes no longer in the directory.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

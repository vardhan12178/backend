import crypto from "crypto";
import fs from "fs";
import path from "path";

// Pure helpers for the catalog v2 import: load, validate, derive fields and build the embedding text.
// Kept free of Mongo and Gemini so they can be unit tested and reused by admin save hooks.

export const DATA_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../data/catalog-v2");

export function loadProducts(dir = DATA_DIR, { category } = {}) {
  const out = [];
  for (const folder of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, folder);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full).sort()) {
      if (!file.endsWith(".json")) continue;
      const doc = JSON.parse(fs.readFileSync(path.join(full, file), "utf8"));
      if (category && doc.category !== category && folder !== category) continue;
      out.push({ file: `${folder}/${file}`, doc });
    }
  }
  return out;
}

/* ------------ Validation ------------ */
const REQUIRED = ["slug", "title", "brand", "category", "variants", "media"];

export function validateProduct(doc) {
  const errors = [];
  for (const key of REQUIRED) if (doc[key] == null || doc[key] === "") errors.push(`missing ${key}`);
  const variants = Array.isArray(doc.variants) ? doc.variants : [];
  if (!variants.length) errors.push("no variants");
  if (variants.filter((v) => v.isDefault).length !== 1) errors.push("needs exactly one default variant");
  for (const v of variants) {
    if (!v.sku) errors.push("variant without sku");
    if (!Number.isInteger(v.price) || !Number.isInteger(v.mrp)) errors.push(`${v.sku}: price/mrp must be integer rupees`);
    else if (v.mrp < v.price) errors.push(`${v.sku}: mrp below price`);
  }
  const media = doc.media || {};
  const images = [...Object.values(media.groups || {}).flat(), ...(media.common || [])];
  if (!images.length) errors.push("no images");
  if (images.some((i) => !i.alt)) errors.push("image without alt text");
  return errors;
}

// Checks rules that span files: unique slugs and unique SKUs.
export function validateCatalog(entries) {
  const errors = [];
  const slugs = new Map();
  const skus = new Map();
  for (const { file, doc } of entries) {
    for (const e of validateProduct(doc)) errors.push(`${file}: ${e}`);
    if (slugs.has(doc.slug)) errors.push(`${file}: duplicate slug (also ${slugs.get(doc.slug)})`);
    slugs.set(doc.slug, file);
    for (const v of doc.variants || []) {
      if (skus.has(v.sku)) errors.push(`${file}: duplicate sku ${v.sku} (also ${skus.get(v.sku)})`);
      skus.set(v.sku, file);
    }
  }
  return errors;
}

/* ------------ Derived fields ------------ */
const rupees = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

const listJoin = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// Files carry stock: null until we have real numbers; fill those with a default so the item is sellable.
export function withStock(doc, defaultStock) {
  return { ...doc, variants: doc.variants.map((v) => ({ ...v, stock: v.stock ?? defaultStock })) };
}

export function derive(doc) {
  const prices = doc.variants.map((v) => v.price);
  return {
    priceRange: { min: Math.min(...prices), max: Math.max(...prices) },
    inStock: doc.variants.some((v) => (v.stock ?? 0) > 0),
  };
}

const KEYSPEC_TEXT = {
  displayInch: (v) => `${v}-inch display`,
  screenInch: (v) => `${v}-inch screen`,
  refreshRateHz: (v) => `${v}Hz refresh rate`,
  ramGB: (v) => `${v}GB RAM`,
  batteryMah: (v) => `${v}mAh battery`,
  mainCameraMP: (v) => `${v}MP main camera`,
  is5G: (v) => (v ? "5G" : null),
  processor: (v) => v,
  chip: (v) => v,
  gpu: (v) => v,
  os: (v) => v,
  resolution: (v) => `${v} resolution`,
  panel: (v) => `${v} panel`,
  responseTimeMs: (v) => `${v}ms response time`,
  gaming: (v) => (v ? "built for gaming" : null),
  curved: (v) => (v ? "curved screen" : null),
  smart: (v) => (v ? "smart features" : null),
  soundW: (v) => `${v}W sound output`,
  chargingW: (v) => `${v}W charging`,
  wirelessCharging: (v) => (v ? "wireless charging" : null),
  foldable: (v) => (v ? "foldable" : null),
  pencil: (v) => v,
  weightKg: (v) => `${v} kg`,
  batteryHours: (v) => `up to ${v} hours battery life`,
  batteryDays: (v) => `up to ${v} days battery life`,
  anc: (v) => (v ? "active noise cancellation" : null),
  codecs: (v) => `${v} codecs`,
  bluetoothCalling: (v) => (v ? "Bluetooth calling" : null),
  amoled: (v) => (v ? "AMOLED display" : null),
  ipRating: (v) => `${v} rated`,
  type: (v) => v,
  capacityL: (v) => `${v} L capacity`,
  capacityKg: (v) => `${v} kg capacity`,
  tonnage: (v) => `${v} ton`,
  starRating: (v) => `${v}-star energy rating`,
  inverter: (v) => (v ? "inverter" : null),
  wattage: (v) => `${v}W`,
  capacity: (v) => v,
  material: (v) => v,
  skinTypes: (v) => `for ${listJoin([].concat(v))} skin`,
  keyIngredients: (v) => `with ${listJoin([].concat(v))}`,
  spf: (v) => `SPF ${v}`,
  fabric: (v) => v,
  fit: (v) => `${v} fit`,
  gender: (v) => `for ${String(v).toLowerCase()}`,
  color: (v) => v,
};

const CATEGORY_NOUN = {
  mobiles: "smartphone", laptops: "laptop", tablets: "tablet", tvs: "TV", monitors: "monitor", audio: "audio",
  wearables: "smartwatch", refrigerators: "refrigerator", "washing-machines": "washing machine",
  "air-conditioners": "air conditioner", "kitchen-appliances": "kitchen appliance",
};

// Short readable paragraph that gets embedded (CATALOG_V2_SCHEMA.md §6). Filtering never relies on it.
export function buildSearchText(doc) {
  const { min, max } = derive(doc).priceRange;
  const price = min === max ? `priced at ${rupees(min)}` : `priced from ${rupees(min)} to ${rupees(max)}`;
  const kind = doc.keySpecs?.productType?.toLowerCase() || CATEGORY_NOUN[doc.category] || doc.category.replace(/-/g, " ");
  const parts = [`${doc.title}: ${kind} by ${doc.brand}, ${price}.`];

  if (doc.shortDescription && doc.shortDescription !== doc.title) parts.push(doc.shortDescription.trim().replace(/\.?$/, "."));

  const specBits = Object.entries(doc.keySpecs || {})
    .filter(([k]) => k !== "productType")
    .map(([k, v]) => (KEYSPEC_TEXT[k] && v != null && v !== "" ? KEYSPEC_TEXT[k](v) : null))
    .filter(Boolean);
  if (specBits.length) parts.push(`${specBits.join(", ")}.`);

  const highlights = (doc.highlights || []).slice(0, 4).map((h) => h.trim().replace(/\.$/, ""));
  if (highlights.length) parts.push(`Highlights: ${highlights.join("; ")}.`);

  const options = (doc.variantOptions || [])
    .map((o) => {
      const values = o.values.map((x) => x.value);
      return values.length > 1 ? `${o.name.toLowerCase()} ${listJoin(values.slice(0, 8))}` : null;
    })
    .filter(Boolean);
  if (options.length) parts.push(`Available in ${options.join("; ")}.`);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Hash of the source file content; unchanged products are skipped on re-runs.
export function contentHash(doc) {
  return crypto.createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
}

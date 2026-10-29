import redis, { CACHE_TTL } from "../utils/redis.js";
import * as catalog from "../services/catalogV2.service.js";

// Public read endpoints for catalog v2. Responses are cached under "v2:*";
// scripts/catalog-v2/import.js clears that prefix after an import.

async function cached(key, ttl, load) {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch { /* cache unavailable: fall through to the database */ }
  const value = await load();
  if (value != null) {
    try { await redis.set(key, JSON.stringify(value), "EX", ttl); } catch { /* best effort */ }
  }
  return value;
}

const queryKey = (query) =>
  Object.keys(query).sort().map((k) => `${k}=${String(query[k]).slice(0, 120)}`).join("&");

export const getCategories = async (req, res) => {
  try {
    res.json(await cached("v2:categories", CACHE_TTL.PRODUCTS_LIST, catalog.getCategories));
  } catch (err) {
    console.error("v2 getCategories:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const listProducts = async (req, res) => {
  try {
    res.json(await cached(`v2:list:${queryKey(req.query)}`, CACHE_TTL.PRODUCTS_LIST, () => catalog.listProducts(req.query)));
  } catch (err) {
    console.error("v2 listProducts:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getProduct = async (req, res) => {
  try {
    const product = await cached(`v2:product:${req.params.slug}`, CACHE_TTL.PRODUCT_DETAIL, () => catalog.getProduct(req.params.slug));
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error("v2 getProduct:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getSimilar = async (req, res) => {
  try {
    const result = await cached(`v2:similar:${req.params.slug}:${req.query.limit || ""}`, CACHE_TTL.PRODUCT_DETAIL,
      () => catalog.getSimilar(req.params.slug, { limit: req.query.limit }));
    if (!result) return res.status(404).json({ error: "Product not found" });
    res.json(result);
  } catch (err) {
    console.error("v2 getSimilar:", err);
    res.status(500).json({ error: "Server error" });
  }
};

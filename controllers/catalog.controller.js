import redis, { CACHE_TTL } from "../utils/redis.js";
import * as catalog from "../services/catalog.service.js";
import { resolveCartLines } from "../services/catalog.stock.js";
import { getActiveSale } from "./sale.controller.js";
import User from "../models/User.js";

const isPrimeUser = async (userId) => {
  if (!userId) return false;
  const user = await User.findById(userId).select("membership").lean();
  return Boolean(user?.membership?.endDate && new Date() < new Date(user.membership.endDate));
};
import { deliveryFor } from "../services/delivery.service.js";

// Public read endpoints for catalog. Responses are cached under "catalog:*";
// scripts/catalog/import.js clears that prefix after an import.
// Bump SHAPE when the response shape changes so stale entries are skipped after a deploy.
const SHAPE = "r4";

// Prices depend on the active sale, so its id and edit time are part of every priced cache key
async function cached(name, ttl, load, sale) {
  const key = name.replace(/^catalog:/, `catalog:${SHAPE}:`) + (sale === undefined ? "" : `:${catalog.saleKey(sale)}`);
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
    res.json(await cached("catalog:categories", CACHE_TTL.PRODUCTS_LIST, catalog.getCategories));
  } catch (err) {
    console.error("catalog getCategories:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const listProducts = async (req, res) => {
  try {
    const sale = await getActiveSale();
    res.json(await cached(`catalog:list:${queryKey(req.query)}`, CACHE_TTL.PRODUCTS_LIST, () => catalog.listProducts(req.query, { sale }), sale));
  } catch (err) {
    console.error("catalog listProducts:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getProduct = async (req, res) => {
  try {
    const sale = await getActiveSale();
    const product = await cached(`catalog:product:${req.params.slug}`, CACHE_TTL.PRODUCT_DETAIL, () => catalog.getProduct(req.params.slug, { sale }), sale);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error("catalog getProduct:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getSimilar = async (req, res) => {
  try {
    const sale = await getActiveSale();
    const result = await cached(`catalog:similar:${req.params.slug}:${req.query.limit || ""}`, CACHE_TTL.PRODUCT_DETAIL,
      () => catalog.getSimilar(req.params.slug, { limit: req.query.limit, sale }), sale);
    if (!result) return res.status(404).json({ error: "Product not found" });
    res.json(result);
  } catch (err) {
    console.error("catalog getSimilar:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Live price/stock for cart lines (not cached: prices and stock must be current)
export const resolveCart = async (req, res) => {
  try {
    const sale = await getActiveSale();
    res.json({ items: await resolveCartLines(req.body.items, { sale, isPrime: await isPrimeUser(req.user?.userId) }) });
  } catch (err) {
    console.error("catalog resolveCart:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getDelivery = async (req, res) => {
  try {
    const result = await deliveryFor(req.params.pincode, { category: req.query.category });
    res.set("Cache-Control", "public, max-age=3600");
    res.json(result);
  } catch (err) {
    console.error("catalog getDelivery:", err);
    res.status(500).json({ error: "Server error" });
  }
};

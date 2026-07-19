import mongoose from "mongoose";
import Product from "../models/Product.js";
import User from "../models/User.js";
import { getActiveSale, overlaySalePricing } from "./sale.controller.js";

/**
 * Recommendations powered by the same Atlas Vector Search index ("vector_index")
 * the AI assistant uses. Two flavours:
 *   - getSimilarProducts:   item-to-item similarity for a product detail page.
 *   - getRecommendedForYou: personalised feed built from a "taste vector"
 *                           (average of the embeddings of products the user has
 *                           ordered, has in their cart, or has wishlisted).
 *
 * Every path degrades gracefully: if the vector index is unavailable or the
 * user has no history, we fall back to category / top-rated browsing so the
 * endpoints never hard-fail.
 */

const VECTOR_INDEX = "vector_index";
const VECTOR_NUM_CANDIDATES = Number(process.env.AI_VECTOR_CANDIDATES || 150);

// Fields the storefront product cards need (+ what overlaySalePricing reads).
const CARD_PROJECTION = {
  title: 1,
  price: 1,
  discountPercentage: 1,
  thumbnail: 1,
  images: 1,
  category: 1,
  brand: 1,
  rating: 1,
  stock: 1,
};

const toObjectId = (v) => {
  try {
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
};

const getIsPrimeUser = async (userId) => {
  if (!userId) return false;
  const user = await User.findById(userId).select("membership").lean();
  return !!(user?.membership?.endDate && new Date() < new Date(user.membership.endDate));
};

/** Component-wise average of equal-length numeric vectors. */
const averageVectors = (vectors) => {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const vec of vectors) {
    if (!Array.isArray(vec) || vec.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += vec[i];
  }
  return sum.map((v) => v / vectors.length);
};

/**
 * Run an Atlas $vectorSearch for a given query vector, excluding a set of ids
 * and inactive products. Returns lean product docs with a `score` field.
 */
const searchByVector = async (queryVector, { limit, excludeIds = [] }) => {
  const exclude = excludeIds.map(toObjectId).filter(Boolean);

  return Product.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(VECTOR_NUM_CANDIDATES, limit * 15),
        limit: limit * 4, // over-fetch, then filter inactive / excluded
      },
    },
    { $addFields: { score: { $meta: "vectorSearchScore" } } },
    {
      $match: {
        isActive: true,
        ...(exclude.length ? { _id: { $nin: exclude } } : {}),
      },
    },
    { $limit: limit },
    { $project: { ...CARD_PROJECTION, score: 1 } },
  ]);
};

const applySale = async (products, isPrime) => {
  if (!products?.length) return products;
  const sale = await getActiveSale().catch(() => null);
  if (sale) overlaySalePricing(products, sale, isPrime);
  return products;
};

/* ──────────────────────────────────────────────────────────────
 * GET /api/products/:id/similar
 * Item-to-item similarity. Works for guests (no auth required).
 * ────────────────────────────────────────────────────────────── */
export const getSimilarProducts = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);
    const isPrime = await getIsPrimeUser(req.user?.userId);

    const source = await Product.findById(id).select("+embedding category").lean();
    if (!source) return res.status(404).json({ message: "Product not found" });

    let results = [];
    if (Array.isArray(source.embedding) && source.embedding.length) {
      try {
        results = await searchByVector(source.embedding, { limit, excludeIds: [id] });
      } catch (err) {
        console.warn("Similar vectorSearch failed, falling back to category:", err.message);
      }
    }

    // Fallback: same-category, best-rated (covers missing embeddings / no index).
    if (!results.length && source.category) {
      results = await Product.find({
        isActive: true,
        category: source.category,
        _id: { $ne: toObjectId(id) },
      })
        .select(CARD_PROJECTION)
        .sort({ isFeatured: -1, rating: -1 })
        .limit(limit)
        .lean();
    }

    await applySale(results, isPrime);
    return res.json({ products: results });
  } catch (err) {
    console.error("getSimilarProducts error:", err);
    return res.status(500).json({ message: "Failed to load similar products" });
  }
};

/* ──────────────────────────────────────────────────────────────
 * GET /api/recommendations/for-you
 * Personalised feed from the user's order/cart/wishlist taste vector.
 * Uses optionalAuth: guests (or users with no history) get trending picks.
 * ────────────────────────────────────────────────────────────── */
export const getRecommendedForYou = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 24);
    const userId = req.user?.userId;
    const isPrime = await getIsPrimeUser(userId);

    let sourceIds = [];
    if (userId) {
      const user = await User.findById(userId)
        .select("cart.productId wishlist.productId")
        .populate({ path: "orders", select: "products.productId", options: { limit: 10, sort: { createdAt: -1 } } })
        .lean();

      if (user) {
        const orderIds = (user.orders || []).flatMap((o) =>
          (o.products || []).map((p) => p.productId)
        );
        const cartIds = (user.cart || []).map((c) => c.productId);
        const wishIds = (user.wishlist || []).map((w) => w.productId);
        // Order matters: purchases first (strongest signal), then cart, then wishlist.
        sourceIds = [...orderIds, ...cartIds, ...wishIds]
          .filter(Boolean)
          .map((v) => String(v));
      }
    }

    // De-dupe while preserving signal order, cap the number of source products.
    const uniqueSourceIds = [...new Set(sourceIds)].slice(0, 30);

    let results = [];
    if (uniqueSourceIds.length) {
      const sources = await Product.find({ _id: { $in: uniqueSourceIds.map(toObjectId).filter(Boolean) } })
        .select("+embedding")
        .lean();
      const vectors = sources.map((p) => p.embedding).filter((v) => Array.isArray(v) && v.length);
      const taste = averageVectors(vectors);

      if (taste) {
        try {
          results = await searchByVector(taste, { limit, excludeIds: uniqueSourceIds });
        } catch (err) {
          console.warn("for-you vectorSearch failed, falling back to trending:", err.message);
        }
      }
    }

    // Cold-start / fallback: featured + top-rated, excluding what they already have.
    let personalized = results.length > 0;
    if (!results.length) {
      results = await Product.find({
        isActive: true,
        ...(uniqueSourceIds.length
          ? { _id: { $nin: uniqueSourceIds.map(toObjectId).filter(Boolean) } }
          : {}),
      })
        .select(CARD_PROJECTION)
        .sort({ isFeatured: -1, rating: -1, createdAt: -1 })
        .limit(limit)
        .lean();
      personalized = false;
    }

    await applySale(results, isPrime);
    return res.json({ products: results, personalized });
  } catch (err) {
    console.error("getRecommendedForYou error:", err);
    return res.status(500).json({ message: "Failed to load recommendations" });
  }
};

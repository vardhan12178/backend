import mongoose from "mongoose";
import CatalogProduct from "../models/CatalogProduct.js";
import CatalogReview from "../models/CatalogReview.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { combinedRating } from "./catalog.ratings.js";
import { invalidatePattern } from "../utils/redis.js";

export class ReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SORTS = {
  recent: { createdAt: -1 },
  helpful: { helpfulCount: -1, createdAt: -1 },
  high: { stars: -1, createdAt: -1 },
  low: { stars: 1, createdAt: -1 },
};

// Reviews are plain text: strip tags and control characters, collapse blank runs
export const cleanText = (s) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// "Asha Rao" -> "Asha R."; one-word names stay as they are
export function publicName(name, fallback = "VKart shopper") {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return fallback;
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

const toId = (v) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));

async function findProduct(slug) {
  const product = await CatalogProduct.findOne({ slug })
    .select("slug priceRange rating variants.sku variants.options")
    .lean();
  if (!product) throw new ReviewError(404, "Product not found");
  return product;
}

/** The shopper's most recent delivered order that contains this product, or null. */
export async function deliveredOrderFor(userId, product) {
  const order = await Order.findOne({
    userId: toId(userId),
    stage: "DELIVERED",
    "products.productId": product._id,
  })
    .select("products createdAt")
    .sort({ createdAt: -1 })
    .lean();
  if (!order) return null;
  const line = order.products.find((p) => String(p.productId) === String(product._id));
  return { orderId: order._id, variant: line?.selectedVariants || "" };
}

/** Recomputes the product's rating from its sample baseline plus every published shopper review. */
export async function refreshRating(product) {
  const [agg] = await CatalogReview.aggregate([
    { $match: { productId: product._id, status: "published" } },
    { $group: { _id: null, sum: { $sum: "$stars" }, n: { $sum: 1 } } },
  ]);
  const { average, count } = combinedRating(product, agg || { sum: 0, n: 0 });
  await CatalogProduct.updateOne({ _id: product._id }, { $set: { rating: { average, count } } });
  await invalidatePattern(`catalog:*:product:${product.slug}*`);
  return { average, count };
}

const shape = (r, viewerId) => ({
  id: String(r._id),
  name: r.displayName,
  stars: r.stars,
  title: r.title,
  body: r.body,
  variant: r.variant || null,
  date: new Date(r.createdAt).toISOString().slice(0, 10),
  helpful: r.helpfulCount ?? (r.helpfulBy || []).length,
  verified: true,
  mine: Boolean(viewerId) && String(r.userId) === String(viewerId),
  voted: Boolean(viewerId) && (r.helpfulBy || []).some((u) => String(u) === String(viewerId)),
});

export async function listReviews(
  slug,
  { sort = "recent", page = 1, limit = 10, viewerId = null } = {}
) {
  const product = await findProduct(slug);
  const filter = { productId: product._id, status: "published" };
  const order = SORTS[sort] || SORTS.recent;
  const [rows, total, mine, eligible] = await Promise.all([
    CatalogReview.aggregate([
      { $match: filter },
      { $addFields: { helpfulCount: { $size: "$helpfulBy" } } },
      { $sort: order },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]),
    CatalogReview.countDocuments(filter),
    viewerId
      ? CatalogReview.findOne({ productId: product._id, userId: toId(viewerId) }).lean()
      : null,
    viewerId ? deliveredOrderFor(viewerId, product) : null,
  ]);
  return {
    reviews: rows.map((r) => shape(r, viewerId)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    // What the viewer may do: write (delivered, none yet), edit theirs, or neither
    canReview: Boolean(eligible) && !mine,
    myReview: mine ? shape(mine, viewerId) : null,
    signedIn: Boolean(viewerId),
  };
}

export async function createReview(userId, slug, { stars, title, body }) {
  const product = await findProduct(slug);
  const delivered = await deliveredOrderFor(userId, product);
  if (!delivered)
    throw new ReviewError(403, "Only shoppers whose order was delivered can review this product");
  const user = await User.findById(userId).select("name username").lean();
  try {
    const review = await CatalogReview.create({
      productId: product._id,
      slug: product.slug,
      userId: toId(userId),
      orderId: delivered.orderId,
      displayName: publicName(user?.name || user?.username),
      variant: delivered.variant,
      stars,
      title: cleanText(title),
      body: cleanText(body),
    });
    await refreshRating(product);
    return shape(review.toObject(), userId);
  } catch (err) {
    if (err?.code === 11000) throw new ReviewError(409, "You have already reviewed this product");
    throw err;
  }
}

async function ownReview(userId, id) {
  if (!mongoose.isValidObjectId(id)) throw new ReviewError(404, "Review not found");
  const review = await CatalogReview.findById(id);
  if (!review) throw new ReviewError(404, "Review not found");
  if (String(review.userId) !== String(userId))
    throw new ReviewError(403, "You can only change your own review");
  return review;
}

export async function updateReview(userId, id, { stars, title, body }) {
  const review = await ownReview(userId, id);
  if (stars !== undefined) review.stars = stars;
  if (title !== undefined) review.title = cleanText(title);
  if (body !== undefined) review.body = cleanText(body);
  await review.save();
  await refreshRating(
    await CatalogProduct.findById(review.productId).select("slug priceRange").lean()
  );
  return shape(review.toObject(), userId);
}

export async function deleteReview(userId, id) {
  const review = await ownReview(userId, id);
  await review.deleteOne();
  await refreshRating(
    await CatalogProduct.findById(review.productId).select("slug priceRange").lean()
  );
}

export async function toggleHelpful(userId, id) {
  if (!mongoose.isValidObjectId(id)) throw new ReviewError(404, "Review not found");
  const review = await CatalogReview.findOne({ _id: id, status: "published" });
  if (!review) throw new ReviewError(404, "Review not found");
  if (String(review.userId) === String(userId))
    throw new ReviewError(400, "You can't vote on your own review");
  const uid = toId(userId);
  const has = review.helpfulBy.some((u) => String(u) === String(uid));
  await CatalogReview.updateOne(
    { _id: review._id },
    has ? { $pull: { helpfulBy: uid } } : { $addToSet: { helpfulBy: uid } }
  );
  const count = review.helpfulBy.length + (has ? -1 : 1);
  return { voted: !has, helpful: count };
}

/* ---------- Moderation (admin "reviews" module) ---------- */
export async function adminList({ status, page = 1, limit = 20 } = {}) {
  const filter = status ? { status } : {};
  const [rows, total] = await Promise.all([
    CatalogReview.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CatalogReview.countDocuments(filter),
  ]);
  const products = await CatalogProduct.find({ _id: { $in: rows.map((r) => r.productId) } })
    .select("title")
    .lean();
  const titles = new Map(products.map((p) => [String(p._id), p.title]));
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    reviews: rows.map((r) => ({
      id: String(r._id),
      slug: r.slug,
      product: titles.get(String(r.productId)) || r.slug,
      name: r.displayName,
      stars: r.stars,
      title: r.title,
      body: r.body,
      status: r.status,
      helpful: (r.helpfulBy || []).length,
      date: new Date(r.createdAt).toISOString().slice(0, 10),
    })),
  };
}

export async function adminSetStatus(id, status) {
  if (!mongoose.isValidObjectId(id)) throw new ReviewError(404, "Review not found");
  const review = await CatalogReview.findByIdAndUpdate(id, { $set: { status } }, { new: true });
  if (!review) throw new ReviewError(404, "Review not found");
  const product = await CatalogProduct.findById(review.productId).select("slug priceRange").lean();
  if (product) await refreshRating(product);
  return { id: String(review._id), status: review.status };
}

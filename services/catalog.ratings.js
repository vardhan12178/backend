import CatalogProduct from "../models/CatalogProduct.js";
import CatalogReview from "../models/CatalogReview.js";
import { ratingFor } from "./catalog.reviews.js";

// Rating = the sample baseline (services/catalog.reviews.js) plus every published shopper review
// (services/catalog.userReviews.js). Shared so start-up sync and review writes agree.
export function combinedRating(product, real = { sum: 0, n: 0 }) {
  const base = ratingFor(product) || { average: 0, count: 0 };
  const count = base.count + real.n;
  const average = count ? Math.round(((base.average * base.count + real.sum) / count) * 10) / 10 : 0;
  return { average, count };
}

// Copies each product's rating into `rating`, so the listing can sort and filter by it in MongoDB.
// Runs at server start and after a catalog import; only products whose rating changed are written.
// Returns how many were updated.
export async function syncRatings() {
  const products = await CatalogProduct.find({}, { slug: 1, priceRange: 1, rating: 1 }).lean();
  const sums = await CatalogReview.aggregate([
    { $match: { status: "published" } },
    { $group: { _id: "$productId", sum: { $sum: "$stars" }, n: { $sum: 1 } } },
  ]);
  const real = new Map(sums.map((s) => [String(s._id), s]));
  const ops = [];
  for (const p of products) {
    const r = combinedRating(p, real.get(String(p._id)));
    if (p.rating?.average !== r.average || p.rating?.count !== r.count) {
      ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { rating: r } } } });
    }
  }
  if (ops.length) await CatalogProduct.bulkWrite(ops, { ordered: false });
  return ops.length;
}

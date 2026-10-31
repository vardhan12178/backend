import CatalogProduct from "../models/CatalogProduct.js";
import { ratingFor } from "./catalogV2.reviews.js";

// Copies each product's sample rating (services/catalogV2.reviews.js) into `rating`, so the
// listing can sort and filter by it in MongoDB. Runs at server start and after a catalog
// import; only products whose rating changed are written. Returns how many were updated.
export async function syncRatings() {
  const products = await CatalogProduct.find({}, { slug: 1, priceRange: 1, rating: 1 }).lean();
  const ops = [];
  for (const p of products) {
    const r = ratingFor(p) || { average: 0, count: 0 };
    if (p.rating?.average !== r.average || p.rating?.count !== r.count) {
      ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { rating: r } } } });
    }
  }
  if (ops.length) await CatalogProduct.bulkWrite(ops, { ordered: false });
  return ops.length;
}

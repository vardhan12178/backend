import Product from "../models/Product.js";
import redis, { CACHE_TTL } from "../utils/redis.js";
import { getActiveSale, overlaySalePricing } from "./sale.controller.js";

/**
 * GET /api/home
 * Single consolidated endpoint returning all data needed by the Home page:
 *   - featured: products from 4 categories (5 each), interleaved
 *   - newArrivals: 12 newest products
 *   - activeSale: current sale (if any)
 *   - stats: real catalog-wide rating/review rollup for the trust section
 */
export const getHomeData = async (req, res) => {
  try {
    const CACHE_KEY = "home:data";

    // Try cache first
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return res.json(JSON.parse(cached));
    } catch { /* ignore redis errors */ }

    // Matches the 4 categories promoted in the "Four ways into the
    // collection" tiles on the homepage, so the Trending grid below it
    // reflects the same categories rather than a disconnected set.
    const categories = ["smartphones", "laptops", "mens-watches", "fragrances"];

    // Execute all queries in parallel
    const [catResults, latestProducts, activeSale, statsAgg] = await Promise.all([
      // 4 category queries
      Promise.all(
        categories.map((cat) =>
          Product.find({ isActive: true, category: cat })
            .sort({ isFeatured: -1, rating: -1 })
            .limit(5)
            .lean()
        )
      ),
      // Latest 12 products
      Product.find({ isActive: true })
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
      // Active sale
      getActiveSale().catch(() => null),
      // Real catalog-wide stats for the homepage trust section (never
      // fabricated testimonials — just an honest rollup of what's in the DB).
      Product.aggregate([
        { $match: { isActive: true } },
        { $project: { rating: 1, reviewCount: { $size: { $ifNull: ["$reviews", []] } } } },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$rating" },
            totalReviews: { $sum: "$reviewCount" },
            totalProducts: { $sum: 1 },
          },
        },
      ]),
    ]);

    const statsRow = statsAgg[0] || null;
    const stats = statsRow
      ? {
          avgRating: Math.round(statsRow.avgRating * 10) / 10,
          totalReviews: statsRow.totalReviews,
          totalProducts: statsRow.totalProducts,
        }
      : null;

    // Interleave round-robin across categories (rather than concatenating)
    // so a slice from the front is a genuine mix, not all from category #1.
    const maxLen = Math.max(...catResults.map((r) => r.length), 0);
    const featured = [];
    for (let i = 0; i < maxLen; i++) {
      for (const catResult of catResults) {
        if (catResult[i]) featured.push(catResult[i]);
      }
    }
    const newArrivals = latestProducts.slice(0, 8);

    // Apply sale pricing overlays
    const sale = activeSale || null;
    if (sale) {
      overlaySalePricing(featured, sale);
      overlaySalePricing(newArrivals, sale);
    }

    const payload = { featured, newArrivals, activeSale: sale, stats };

    // Cache for 5 minutes
    try {
      await redis.set(CACHE_KEY, JSON.stringify(payload), "EX", CACHE_TTL.HOME);
    } catch { /* ignore */ }

    res.json(payload);
  } catch (err) {
    console.error("Home data error:", err);
    res.status(500).json({ error: "Failed to load home data" });
  }
};

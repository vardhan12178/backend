import Product from "../models/Product.js";
import redis, { CACHE_TTL } from "../utils/redis.js";
import { getActiveSale, overlaySalePricing } from "./sale.controller.js";

/**
 * GET /api/home
 * Single consolidated endpoint returning all data needed by the Home page:
 *   - featured: products from 4 categories (5 each)
 *   - newArrivals: 12 newest products
 *   - activeSale: current sale (if any)
 */
export const getHomeData = async (req, res) => {
  try {
    const CACHE_KEY = "home:data";

    // Try cache first
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return res.json(JSON.parse(cached));
    } catch { /* ignore redis errors */ }

    const categories = ["beauty", "fragrances", "smartphones", "laptops"];

    // Execute all queries in parallel
    const [catResults, latestProducts, activeSale] = await Promise.all([
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
    ]);

    const featured = catResults.flat().slice(0, 16);
    const newArrivals = latestProducts.slice(0, 8);

    // Apply sale pricing overlays
    const sale = activeSale || null;
    if (sale) {
      overlaySalePricing(featured, sale);
      overlaySalePricing(newArrivals, sale);
    }

    const payload = { featured, newArrivals, activeSale: sale };

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

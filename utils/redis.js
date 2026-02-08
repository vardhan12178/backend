import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis(process.env.REDIS_URL);

redis.on("connect", () => {
  console.log("Redis Connected Successfully");
});

redis.on("error", (err) => {
  console.error("Redis Connection Error:", err);
});

/* ── Centralised TTL constants (seconds) ── */
export const CACHE_TTL = {
  PRODUCTS_LIST: 300,   // 5 min  – default listing page
  PRODUCT_DETAIL: 600,  // 10 min – single product
  PROFILE: 3600,        // 1 hr   – user profile
  SALE: 60,             // 1 min  – active sale
  HOME: 300,            // 5 min  – home page data
  TWO_FA: 300,          // 5 min  – 2FA challenge
};

/**
 * Invalidate all keys matching a pattern (SCAN-based, safe for production).
 * Example: invalidatePattern("products:*")
 */
export async function invalidatePattern(pattern) {
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  } catch (err) {
    console.warn("Redis invalidatePattern error:", err.message);
  }
}

export default redis;
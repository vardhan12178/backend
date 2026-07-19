import redis from "./redis.js";
import TokenBlacklist from "../models/TokenBlacklist.js";

const PREFIX = "bl:";

/**
 * Revoke a JWT until it naturally expires.
 * Writes to Redis (fast-path reads) and Mongo (durable audit + fallback when
 * Redis is unavailable). Redis auto-expires the key via TTL, mirroring the
 * Mongo TTL index on `expiredAt`.
 *
 * @param {string} token   The raw JWT to revoke.
 * @param {Date|number} expiresAt  When the token expires (Date or epoch ms).
 */
export async function revokeToken(token, expiresAt) {
  if (!token) return;

  const expiry = new Date(expiresAt);
  await TokenBlacklist.updateOne(
    { token },
    { $set: { token, expiredAt: expiry } },
    { upsert: true }
  );

  const ttlSec = Math.ceil((expiry.getTime() - Date.now()) / 1000);
  if (ttlSec > 0) {
    try {
      await redis.set(`${PREFIX}${token}`, "1", "EX", ttlSec);
    } catch (err) {
      console.warn("Redis revokeToken error:", err.message);
    }
  }
}

/**
 * Returns true if the token has been revoked.
 * Reads Redis first (the hot path — runs on every authenticated request), and
 * only falls back to Mongo when Redis itself is unavailable. Valid tokens
 * therefore no longer hit the database on every request.
 *
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function isTokenRevoked(token) {
  if (!token) return false;
  try {
    return (await redis.get(`${PREFIX}${token}`)) !== null;
  } catch (err) {
    console.warn("Redis isTokenRevoked error — falling back to Mongo:", err.message);
    const found = await TokenBlacklist.findOne({ token }).lean();
    return !!found;
  }
}

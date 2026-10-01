import redis from "../utils/redis.js";

/*
 * Daily cap on Gemini-backed endpoints (chat, natural-language search,
 * comparison verdict), shared across all three. Signed-in shoppers get a
 * generous allowance; anonymous traffic is keyed by IP and capped lower, so
 * the public endpoints can't be used to run up the Gemini bill.
 *
 * Limits are read per request so they can be tuned via env without a
 * redeploy of code: AI_DAILY_LIMIT_USER (default 100), AI_DAILY_LIMIT_GUEST
 * (default 20). Fails open if Redis is unavailable — the per-minute rate
 * limiters still apply.
 */
const DAY_SECONDS = 26 * 60 * 60; // a little over a day, so the key outlives its UTC date

const limitFor = (isUser) =>
  isUser
    ? Number(process.env.AI_DAILY_LIMIT_USER) || 100
    : Number(process.env.AI_DAILY_LIMIT_GUEST) || 20;

export const aiDailyQuota = async (req, res, next) => {
  const isUser = !!req.user?.userId;
  const who = isUser ? `u:${req.user.userId}` : `ip:${req.ip}`;
  const key = `ai:quota:${new Date().toISOString().slice(0, 10)}:${who}`;
  const limit = limitFor(isUser);

  try {
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, DAY_SECONDS);

    res.set("X-AI-Quota-Limit", String(limit));
    res.set("X-AI-Quota-Remaining", String(Math.max(0, limit - used)));

    if (used > limit) {
      return res.status(429).json({
        error: isUser
          ? "You've reached today's limit for the AI assistant. It resets tomorrow."
          : "You've reached today's AI limit for guests. Sign in to keep chatting.",
        quotaExceeded: true,
      });
    }
  } catch (err) {
    console.warn("[ai-quota] check failed, allowing request:", err.message);
  }
  next();
};

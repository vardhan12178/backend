import redis from "../utils/redis.js";

/*
 * Real-user Core Web Vitals.
 *
 * The storefront beacons each metric once per page view. We keep a rolling
 * window of the most recent samples per metric in Redis (no Mongo writes on
 * the hot path) and summarise them on demand for the admin dashboard, so
 * performance work can be measured before/after against real traffic.
 */

export const VITAL_NAMES = ["LCP", "INP", "CLS", "FCP", "TTFB"];
const RATINGS = ["good", "needs-improvement", "poor"];
const SAMPLE_LIMIT = 1000;
const MAX_VALUE = { CLS: 10 }; // unitless; the rest are milliseconds
const DEFAULT_MAX_MS = 120000;

const keyFor = (name) => `vitals:${name}`;

// Only keep the route shape, never ids/tokens: /product/66f… -> /product/:id,
// /order-success/VK-1042 -> /order-success/:id
export function normalizePath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  const path = raw.split(/[?#]/)[0].slice(0, 120);
  return path
    .split("/")
    // Ids, order numbers and tokens all contain digits; route names never do.
    .map((seg) => (/\d/.test(seg) || seg.length > 40 ? ":id" : seg))
    .join("/");
}

/* POST /api/vitals — public beacon endpoint, always answers 204 */
export const recordVital = async (req, res) => {
  try {
    const { name, value, rating, path } = req.body || {};
    const num = Number(value);
    const max = MAX_VALUE[name] ?? DEFAULT_MAX_MS;
    if (VITAL_NAMES.includes(name) && Number.isFinite(num) && num >= 0 && num <= max && RATINGS.includes(rating)) {
      const sample = JSON.stringify({ v: Math.round(num * 1000) / 1000, r: rating, p: normalizePath(path), t: Date.now() });
      await redis.lpush(keyFor(name), sample);
      await redis.ltrim(keyFor(name), 0, SAMPLE_LIMIT - 1);
    }
  } catch (err) {
    // Telemetry must never surface errors to visitors.
    console.warn("[vitals] record failed:", err.message);
  }
  res.status(204).end();
};

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};

/* GET /api/admin/vitals — p75 + rating split per metric over the rolling window */
export const getVitalsSummary = async (req, res) => {
  try {
    const metrics = {};
    for (const name of VITAL_NAMES) {
      const raw = await redis.lrange(keyFor(name), 0, -1);
      const samples = (raw || [])
        .map((s) => {
          try { return JSON.parse(s); } catch { return null; }
        })
        .filter(Boolean);
      const values = samples.map((s) => s.v).sort((a, b) => a - b);
      const count = samples.length;
      const share = (rating) => (count ? Math.round((samples.filter((s) => s.r === rating).length / count) * 100) : 0);
      metrics[name] = {
        count,
        p75: percentile(values, 75),
        good: share("good"),
        needsImprovement: share("needs-improvement"),
        poor: share("poor"),
        since: count ? Math.min(...samples.map((s) => s.t)) : null,
      };
    }
    res.json({ metrics, windowSize: SAMPLE_LIMIT });
  } catch (err) {
    console.error("[vitals] summary failed:", err);
    res.status(500).json({ message: "Could not load web vitals" });
  }
};

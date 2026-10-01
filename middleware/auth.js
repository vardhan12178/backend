import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import { isTokenRevoked } from "../utils/tokenBlacklist.js";

const tokenFrom = (req) => {
  const bearer = req.headers.authorization;
  return req.cookies?.jwt_token || (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
};

/**
 * Resolve a raw JWT to the acting user's *current* identity.
 *
 * The token only proves who the caller is. Roles, admin role and blocked
 * status are read fresh from the DB on every request instead of trusting the
 * copy baked into a 30-day token, so demoting an admin or blocking a user
 * takes effect immediately (one indexed _id lookup per request — the same
 * thing requirePermission already does for admin routes).
 *
 * Returns { user } on success or { status, error } on failure. Throws only on
 * infrastructure errors (DB unreachable).
 */
export async function resolveAuthToken(token) {
  if (!token) return { status: 401, error: "unauthorized" };

  // check blacklist (Redis-first, Mongo fallback)
  if (await isTokenRevoked(token)) return { status: 401, error: "token invalidated" };

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    console.error("JWT verification error:", err.message);
    return { status: 403, error: "forbidden" };
  }

  if (!payload?.userId || !mongoose.isValidObjectId(payload.userId)) {
    return { status: 401, error: "unauthorized" };
  }

  const account = await User.findById(payload.userId).select("roles adminRole blocked").lean();
  if (!account) return { status: 401, error: "unauthorized" };
  // 401 (not 403) so the storefront treats it as a lost session and signs out.
  if (account.blocked) return { status: 401, error: "account blocked" };

  return {
    user: {
      ...payload,
      roles: Array.isArray(account.roles) && account.roles.length ? account.roles : ["user"],
      adminRole: account.adminRole || null,
    },
  };
}

export const authenticateJWT = async (req, res, next) => {
  try {
    const result = await resolveAuthToken(tokenFrom(req));
    if (!result.user) return res.status(result.status).json({ error: result.error });

    // { userId, roles, adminRole, iat, exp } — roles/adminRole are current DB values
    req.user = result.user;
    next();
  } catch (err) {
    console.error("Auth lookup error:", err.message);
    return res.status(500).json({ error: "authentication unavailable" });
  }
};

export const requireAdmin = (req, res, next) => {
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  if (!req.user || !roles.includes("admin")) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

export const optionalAuth = async (req, _res, next) => {
  const token = tokenFrom(req);
  if (!token) return next();

  try {
    // Revoked, invalid or blocked — continue as unauthenticated.
    const result = await resolveAuthToken(token);
    if (result.user) req.user = result.user;
  } catch {
    // auth lookup unavailable — continue as unauthenticated
  }
  next();
};

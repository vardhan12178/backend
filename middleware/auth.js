import jwt from "jsonwebtoken";
import TokenBlacklist from "../models/TokenBlacklist.js";

export const authenticateJWT = async (req, res, next) => {
  const bearer = req.headers.authorization;
  const token =
    req.cookies?.jwt_token ||
    (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);

  if (!token) return res.status(401).json({ error: "unauthorized" });

  try {
    // check blacklist
    const blacklisted = await TokenBlacklist.findOne({ token });
    if (blacklisted) {
      return res.status(401).json({ error: "token invalidated" });
    }

    // verify JWT
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // store user { userId, role? }
    req.user = payload;

    next();
  } catch (err) {
    console.error("JWT verification error:", err.message);
    return res.status(403).json({ error: "forbidden" });
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
  const bearer = req.headers.authorization;
  const token =
    req.cookies?.jwt_token ||
    (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);

  if (!token) return next();

  try {
    // Check blacklist (same as authenticateJWT)
    const blacklisted = await TokenBlacklist.findOne({ token });
    if (blacklisted) return next(); // treat as unauthenticated

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
  } catch {
    // invalid token — continue as unauthenticated
  }
  next();
};

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

/* ---------- ADMIN-ONLY MIDDLEWARE ---------- */
export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

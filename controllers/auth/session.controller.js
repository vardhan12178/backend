import jwt from "jsonwebtoken";
import User from "../../models/User.js";
import { revokeToken } from "../../utils/tokenBlacklist.js";
import { buildClearCookieOpts } from "../../utils/cookies.js";

const AUTH_USER_SELECT =
  "name username email profileImage createdAt twoFactorEnabled suppress2faPrompt membership blocked";

export const buildSessionPayload = async (userId) => {
  const user = await User.findById(userId).select(AUTH_USER_SELECT).lean();

  if (!user || user.blocked) {
    return { authenticated: false, user: null };
  }

  const { blocked, ...safeUser } = user;

  return {
    authenticated: true,
    user: {
      ...safeUser,
      isPrime: !!(
        safeUser.membership?.endDate && new Date(safeUser.membership.endDate) > new Date()
      ),
    },
  };
};

export const checkAuth = async (req, res) => {
  try {
    if (!req.user?.userId) {
      return res.json({ authenticated: false, user: null });
    }

    return res.json(await buildSessionPayload(req.user.userId));
  } catch (err) {
    console.error("Auth check error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Logout
export const logout = async (req, res) => {
  try {
    const token = req.cookies.jwt_token || req.headers.authorization?.split(" ")[1];
    if (token) {
      // Ignore malformed/forged tokens instead of storing arbitrary strings.
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const expMs =
          Number(payload?.exp) > 0
            ? Number(payload.exp) * 1000
            : Date.now() + 30 * 24 * 60 * 60 * 1000;

        await revokeToken(token, expMs);
      } catch {
        // Nothing to blacklist if token is invalid.
      }
    }
    res.clearCookie("jwt_token", buildClearCookieOpts(req));
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

import express from "express";
import rateLimit from "express-rate-limit";
import User from "../models/User.js";
import { authenticateJWT } from "../middleware/auth.js";
import * as twoFactorController from "../controllers/twofactor.controller.js";

const router = express.Router();

// Strict rate limiter for 2FA verification (prevent brute-force)
const twoFAVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 5,               // 5 attempts per minute
  standardHeaders: true,
  message: { message: "Too many 2FA attempts. Please try again later." },
});

// Middleware to fetch full user document (Used by 2FA setup/toggle routes)
const requireUserDoc = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(500).json({ message: "Server error" });
  }
};

// 1) generate secret + QR
router.post("/2fa/setup", authenticateJWT, requireUserDoc, twoFactorController.setup2FA);

// 2) enable 2FA
router.post("/2fa/enable", authenticateJWT, requireUserDoc, twoFactorController.enable2FA);

// 3) disable
router.post("/2fa/disable", authenticateJWT, requireUserDoc, twoFactorController.disable2FA);

// 4) verify (login) — rate limited to prevent brute-force
router.post("/2fa/login-verify", twoFAVerifyLimiter, twoFactorController.verify2FA);

// 5) suppress popup
router.post("/2fa/suppress", authenticateJWT, requireUserDoc, twoFactorController.suppress2FAPrompt);

export default router;

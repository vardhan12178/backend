import express from "express";
import { aiChatLimiter, aiCompareLimiter } from "../middleware/security.js";
import { optionalAuth } from "../middleware/auth.js";
import { aiDailyQuota } from "../middleware/aiQuota.js";
import * as aiController from "../controllers/ai.controller.js";

const router = express.Router();

// Health Check
router.get("/health", aiController.getHealth);

// Chat Endpoint — optionalAuth to identify user, rate limited, daily quota
// (signed-in users get a bigger allowance than guests; see aiDailyQuota)
router.post("/chat", optionalAuth, aiChatLimiter, aiDailyQuota, aiController.chat);

// Natural language search -> structured filters, rate limited
router.post("/parse-search", optionalAuth, aiChatLimiter, aiDailyQuota, aiController.parseSearch);

// AI verdict for a 2-4 product comparison, rate limited
router.post("/compare", optionalAuth, aiCompareLimiter, aiDailyQuota, aiController.compareProducts);

export default router;
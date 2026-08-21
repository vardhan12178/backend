import express from "express";
import { aiChatLimiter, aiCompareLimiter } from "../middleware/security.js";
import { optionalAuth } from "../middleware/auth.js";
import * as aiController from "../controllers/ai.controller.js";

const router = express.Router();

// Health Check
router.get("/health", aiController.getHealth);

// Chat Endpoint — optionalAuth to identify user, rate limited
router.post("/chat", optionalAuth, aiChatLimiter, aiController.chat);

// Natural language search -> structured filters, rate limited
router.post("/parse-search", aiChatLimiter, aiController.parseSearch);

// AI verdict for a 2-4 product comparison, rate limited
router.post("/compare", aiCompareLimiter, aiController.compareProducts);

export default router;
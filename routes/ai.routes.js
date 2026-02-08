import express from "express";
import { aiChatLimiter } from "../middleware/security.js";
import { optionalAuth } from "../middleware/auth.js";
import * as aiController from "../controllers/ai.controller.js";

const router = express.Router();

// Health Check
router.get("/health", aiController.getHealth);

// Chat Endpoint — optionalAuth to identify user, rate limited
router.post("/chat", optionalAuth, aiChatLimiter, aiController.chat);

export default router;
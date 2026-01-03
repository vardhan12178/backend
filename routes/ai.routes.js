import express from "express";
import { aiChatLimiter } from "../middleware/security.js";
import * as aiController from "../controllers/ai.controller.js";

const router = express.Router();

// Health Check
router.get("/health", aiController.getHealth);

// Chat Endpoint
router.post("/chat", aiChatLimiter, aiController.chat);

export default router;
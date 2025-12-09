// routes/ai.routes.js
import express from "express";
import { handleChat } from "../services/ai.service.js"; // ← Your new service (create first, see below)

const router = express.Router();

/**
 * GET /api/ai/health
 * Simple health check for AI service (optional, for testing)
 */
router.get("/health", async (req, res) => {
  res.json({ status: "AI service ready", message: "Chatbot powered by RAG + local LLM" });
});

/**
 * POST /api/ai/chat
 * AI-powered product search & recommendations
 * 
 * Body: { "message": "wireless earbuds under 2000 with good bass" }
 * 
 * Response: { "reply": "Friendly AI response...", "products": [array of 3 matches] }
 */
router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || message.trim().length < 3) {
      return res.status(400).json({ error: "Message too short (min 3 chars)" });
    }

    const response = await handleChat(message.trim());
    res.json(response);
  } catch (error) {
    console.error("Chat route error:", error);
    res.status(500).json({ error: "AI service unavailable – check Chroma server" });
  }
});

export default router;
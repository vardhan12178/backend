import { handleChat, parseSearchQuery } from "../services/ai.service.js";
import Product from "../models/Product.js";

/* GET HEALTH */
export const getHealth = (req, res) => {
    res.json({
        status: "online",
        service: "VKart Copilot",
        model: process.env.GEMINI_CHAT_MODEL || "gemini-flash-lite-latest"
    });
};

/* POST CHAT */
export const chat = async (req, res) => {
    try {
        const { message, history = [] } = req.body;

        // 1. Input Validation
        if (!message || typeof message !== "string" || message.trim().length < 2) {
            return res.status(400).json({
                error: "Message is too short. Please type at least 2 characters."
            });
        }

        // 2. History Validation (Security Check)
        if (!Array.isArray(history)) {
            return res.status(400).json({ error: "Invalid history format" });
        }

        // 3. Process Request
        const response = await handleChat(message.trim(), history);

        // 4. Return Result
        res.json(response);

    } catch (error) {
        console.error("Chat route error:", error);

        // Graceful Error Handling
        res.status(500).json({
            error: "AI service is currently busy. Please try standard search."
        });
    }
};

/* POST /api/ai/parse-search - Natural language query -> structured filters */
export const parseSearch = async (req, res) => {
    try {
        const { query } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 3) {
            return res.status(400).json({
                error: "Query is too short. Please type at least 3 characters."
            });
        }

        // Ground the parser against the real, current category list so it
        // can never invent a category slug that doesn't exist in the catalog.
        const categories = await Product.distinct("category", { isActive: true });
        const parsed = await parseSearchQuery(query.trim(), categories);

        res.json(parsed);
    } catch (error) {
        console.error("Search parse error:", error.message);
        res.status(503).json({
            error: "AI search is currently busy. Please use the filters instead."
        });
    }
};

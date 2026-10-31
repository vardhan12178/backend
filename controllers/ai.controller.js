import { handleChat, rankChat, parseSearchQuery } from "../services/ai.service.js";
import { CATEGORY_GROUPS } from "../services/catalog.service.js";

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
        // twoPhase: results come back right after the search, the model's picks via POST /api/ai/chat/rank
        const response = await handleChat(message.trim(), history.slice(-10), { twoPhase: req.body.twoPhase === true });

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

/* POST CHAT RANK - phase two of a two-phase answer */
export const rankChatTurn = async (req, res) => {
    try {
        const { token } = req.body;
        if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) {
            return res.status(400).json({ error: "Invalid rank token" });
        }
        const result = await rankChat(token);
        if (!result) return res.status(404).json({ error: "This answer has expired. Please ask again." });
        res.json({ structured: result.structured, products: result.products, reranked: result.reranked });
    } catch (error) {
        console.error("Chat rank error:", error.message);
        res.status(503).json({ error: "AI ranking is currently busy." });
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

        // Grounded against the storefront categories, so the parser can't invent one
        const categories = CATEGORY_GROUPS.map((g) => ({ slug: g.slug, name: g.name }));
        const parsed = await parseSearchQuery(query.trim(), categories);

        res.json(parsed);
    } catch (error) {
        console.error("Search parse error:", error.message);
        res.status(503).json({
            error: "AI search is currently busy. Please use the filters instead."
        });
    }
};

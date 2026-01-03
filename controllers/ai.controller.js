import { handleChat } from "../services/ai.service.js";

/* GET HEALTH */
export const getHealth = (req, res) => {
    res.json({
        status: "online",
        service: "VKart Copilot",
        model: "Gemini 2.5 Flash"
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

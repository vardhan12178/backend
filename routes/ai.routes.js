import express from "express";
import { handleAIQuery } from "../controllers/ai.controller.js";

const router = express.Router();

router.post("/ask-ai", handleAIQuery);

export default router; // 👈 make sure this line exists

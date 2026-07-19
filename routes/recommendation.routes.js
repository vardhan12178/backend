import express from "express";
import { optionalAuth } from "../middleware/auth.js";
import {
  getSimilarProducts,
  getRecommendedForYou,
} from "../controllers/recommendation.controller.js";

const router = express.Router();

// optionalAuth: both work for guests; auth just personalises / applies Prime pricing.
router.get("/products/:id/similar", optionalAuth, getSimilarProducts);
router.get("/recommendations/for-you", optionalAuth, getRecommendedForYou);

export default router;

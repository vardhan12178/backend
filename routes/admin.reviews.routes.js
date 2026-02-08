import express from "express";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import * as reviewController from "../controllers/admin.reviews.controller.js";

const router = express.Router();

router.use(authenticateJWT, requireAdmin);

router.get("/", reviewController.listReviews);
router.patch("/:productId/:reviewId/toggle", reviewController.toggleReviewVisibility);
router.delete("/:productId/:reviewId", reviewController.deleteReviewAdmin);

export default router;

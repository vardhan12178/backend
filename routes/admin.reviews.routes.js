import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as reviewController from "../controllers/admin.reviews.controller.js";

const router = express.Router();

router.use(authenticateJWT);

router.get("/", requirePermission("reviews", "read"), reviewController.listReviews);
router.patch("/:productId/:reviewId/toggle", requirePermission("reviews", "write"), reviewController.toggleReviewVisibility);
router.delete("/:productId/:reviewId", requirePermission("reviews", "write"), reviewController.deleteReviewAdmin);

export default router;

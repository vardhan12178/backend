import express from "express";
import { body } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import * as couponController from "../controllers/coupon.controller.js";

const router = express.Router();

// Admin routes
router.post("/", authenticateJWT, requireAdmin, [
  body("code").isString().trim().notEmpty().isLength({ max: 30 }),
  body("discountType").isIn(["percentage", "flat"]),
  body("discountValue").isFloat({ gt: 0 }),
], validate, couponController.createCoupon);
router.get("/all", authenticateJWT, requireAdmin, couponController.listCoupons);
router.patch("/:id", authenticateJWT, requireAdmin, couponController.updateCoupon);
router.delete("/:id", authenticateJWT, requireAdmin, couponController.deleteCoupon);

// User-facing routes
router.get("/public", couponController.getPublicCoupons);
router.post("/validate", authenticateJWT, [
  body("code").isString().trim().notEmpty(),
  body("total").isFloat({ gt: 0 }),
], validate, couponController.validateCoupon);

export default router;

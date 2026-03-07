import express from "express";
import { body } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import * as couponController from "../controllers/coupon.controller.js";

const router = express.Router();

// Admin routes
router.post("/", authenticateJWT, requireAdmin, [
  body("code").isString().trim().notEmpty().isLength({ max: 30 }),
  body("type").isIn(["percent", "flat"]),
  body("value").isFloat({ gt: 0 }),
], validate, couponController.createCoupon);
router.get("/all", authenticateJWT, requireAdmin, couponController.listCoupons);
router.patch("/:id", authenticateJWT, requireAdmin, couponController.updateCoupon);
router.delete("/:id", authenticateJWT, requireAdmin, couponController.deleteCoupon);

// User-facing routes
router.get("/public", couponController.getPublicCoupons);
router.post("/validate", authenticateJWT, [
  body("code").isString().trim().notEmpty(),
  body("subtotal").isFloat({ gt: 0 }),
], validate, couponController.validateCoupon);

export default router;

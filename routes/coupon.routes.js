import express from "express";
import { body } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as couponController from "../controllers/coupon.controller.js";

const router = express.Router();

// Admin routes
router.post("/", authenticateJWT, requirePermission("coupons", "write"), [
  body("code").isString().trim().notEmpty().isLength({ max: 30 }),
  body("type").isIn(["percent", "flat"]),
  body("value").isFloat({ gt: 0 }),
], validate, couponController.createCoupon);
router.get("/all", authenticateJWT, requirePermission("coupons", "read"), couponController.listCoupons);
router.patch("/:id", authenticateJWT, requirePermission("coupons", "write"), couponController.updateCoupon);
router.delete("/:id", authenticateJWT, requirePermission("coupons", "write"), couponController.deleteCoupon);

// User-facing routes
router.get("/public", couponController.getPublicCoupons);
router.post("/validate", authenticateJWT, [
  body("code").isString().trim().notEmpty(),
  body("subtotal").isFloat({ gt: 0 }),
], validate, couponController.validateCoupon);

export default router;

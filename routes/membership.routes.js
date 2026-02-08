import express from "express";
import { body } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import * as memberCtrl from "../controllers/membership.controller.js";

const router = express.Router();

router.get("/plans", memberCtrl.getPlans);

router.get("/status", authenticateJWT, memberCtrl.getStatus);
router.post("/purchase", authenticateJWT, [
  body("planId").isMongoId().withMessage("Valid planId is required"),
], validate, memberCtrl.purchasePlan);
router.post("/verify", authenticateJWT, [
  body("razorpay_order_id").isString().notEmpty(),
  body("razorpay_payment_id").isString().notEmpty(),
  body("razorpay_signature").isString().notEmpty(),
  body("planId").isMongoId(),
], validate, memberCtrl.verifyAndActivate);

router.get("/admin/plans", authenticateJWT, requireAdmin, memberCtrl.adminListPlans);
router.post("/admin/plans", authenticateJWT, requireAdmin, [
  body("name").isString().trim().notEmpty(),
  body("price").isFloat({ gt: 0 }),
  body("durationDays").isInt({ gt: 0 }),
], validate, memberCtrl.adminCreatePlan);
router.put("/admin/plans/:id", authenticateJWT, requireAdmin, memberCtrl.adminUpdatePlan);
router.delete("/admin/plans/:id", authenticateJWT, requireAdmin, memberCtrl.adminDeletePlan);

export default router;

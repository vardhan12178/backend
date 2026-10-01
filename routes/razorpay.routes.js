import express from "express";
import { body } from "express-validator";
import * as paymentController from "../controllers/payment.controller.js";
import { authenticateJWT } from "../middleware/auth.js";
import validate from "../middleware/validate.js";

const router = express.Router();

router.post("/razorpay/create-order", authenticateJWT, [
    // Preferred: the cart itself, priced server-side.
    body("products").optional().isArray({ min: 1, max: 50 }),
    body("products.*.productId").isMongoId(),
    body("products.*.quantity").isInt({ gt: 0, lt: 1000 }),
    body("products.*.selectedVariants").optional({ nullable: true }).isString(),
    body("promo").optional({ nullable: true }).isString().isLength({ max: 40 }),
    body("walletUsed").optional().isFloat({ min: 0 }),
    // Legacy: bare amount from an older storefront build (see controller).
    body("amount").optional().isFloat({ gt: 0 }),
    body("currency").optional().isString().isLength({ min: 3, max: 3 }),
], validate, paymentController.createOrder);

router.post("/razorpay/verify", authenticateJWT, [
    body("razorpay_order_id").isString().notEmpty(),
    body("razorpay_payment_id").isString().notEmpty(),
    body("razorpay_signature").isString().notEmpty(),
], validate, paymentController.verifyPayment);

// Server-to-server call from Razorpay itself — no user session, authenticity
// is enforced by the x-razorpay-signature check inside the controller.
router.post("/razorpay/webhook", paymentController.handleWebhook);

export default router;

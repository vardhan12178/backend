import express from "express";
import { body } from "express-validator";
import * as paymentController from "../controllers/payment.controller.js";
import { authenticateJWT } from "../middleware/auth.js";
import validate from "../middleware/validate.js";

const router = express.Router();

router.post("/razorpay/create-order", authenticateJWT, [
    body("amount").isFloat({ gt: 0 }),
    body("currency").optional().isString().isLength({ min: 3, max: 3 }),
], validate, paymentController.createOrder);

router.post("/razorpay/verify", authenticateJWT, [
    body("razorpay_order_id").isString().notEmpty(),
    body("razorpay_payment_id").isString().notEmpty(),
    body("razorpay_signature").isString().notEmpty(),
], validate, paymentController.verifyPayment);

export default router;

import express from "express";
import * as paymentController from "../controllers/payment.controller.js";
import { authenticateJWT } from "../middleware/auth.js";

const router = express.Router();

router.post("/razorpay/create-order", authenticateJWT, paymentController.createOrder);

router.post("/razorpay/verify", authenticateJWT, paymentController.verifyPayment);

export default router;

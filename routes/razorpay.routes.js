import express from "express";
import * as paymentController from "../controllers/payment.controller.js";

const router = express.Router();

router.post("/razorpay/create-order", paymentController.createOrder);

router.post("/razorpay/verify", paymentController.verifyPayment);

export default router;

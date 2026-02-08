import express from "express";
import { body } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT } from "../middleware/auth.js";
import * as walletController from "../controllers/wallet.controller.js";

const router = express.Router();

router.get("/wallet", authenticateJWT, walletController.getWallet);
router.post("/wallet/topup", authenticateJWT, [
  body("amount").isFloat({ gt: 0, lt: 100001 }).withMessage("Amount must be between 1 and 100000"),
], validate, walletController.createTopupOrder);
router.post("/wallet/verify", authenticateJWT, [
  body("razorpay_order_id").isString().notEmpty(),
  body("razorpay_payment_id").isString().notEmpty(),
  body("razorpay_signature").isString().notEmpty(),
], validate, walletController.verifyTopup);

export default router;

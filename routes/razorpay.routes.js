import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

router.post("/razorpay/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", receipt = "vkart_demo_receipt" } = req.body;

    if (!amount) return res.status(400).json({ success: false, message: "Amount is required" });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
      receipt,
      payment_capture: 1,
    });

    res.json({
      success: true,
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
    });
  } catch (err) {
    console.error("Razorpay order error:", err);
    res.status(500).json({ success: false, message: "Failed to create Razorpay order" });
  }
});

router.post("/razorpay/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature)
      return res.json({ success: true, message: "Payment verified" });

    res.status(400).json({ success: false, message: "Invalid signature" });
  } catch (err) {
    console.error("Razorpay verify error:", err);
    res.status(500).json({ success: false, message: "Verification failed" });
  }
});

export default router; 

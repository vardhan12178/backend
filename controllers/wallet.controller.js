import Razorpay from "razorpay";
import crypto from "crypto";
import User from "../models/User.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export const getWallet = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("walletBalance walletTransactions");
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({
      balance: user.walletBalance || 0,
      transactions: user.walletTransactions?.slice(-20).reverse() || [],
    });
  } catch (err) {
    console.error("Get wallet error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const createTopupOrder = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Amount is required" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `wallet_topup_${Date.now()}`,
      payment_capture: 1,
    });

    res.json({
      success: true,
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
    });
  } catch (err) {
    console.error("Wallet topup order error:", err);
    res.status(500).json({ message: "Failed to create wallet top-up order" });
  }
};

export const verifyTopup = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Missing payment fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid signature" });
    }

    // Fetch actual paid amount from Razorpay (never trust client)
    const rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
    const creditAmount = Math.max(0, (rzpOrder.amount_paid || 0) / 100);
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Prevent double credit for same payment id
    const exists = (user.walletTransactions || []).some((t) => t.paymentId === razorpay_payment_id);
    if (exists) return res.json({ success: true, balance: user.walletBalance });

    user.walletBalance = Math.round((user.walletBalance + creditAmount) * 100) / 100;
    user.walletTransactions.push({
      type: "CREDIT",
      amount: creditAmount,
      reason: "Wallet top-up",
      paymentId: razorpay_payment_id,
    });

    await user.save();
    return res.json({ success: true, balance: user.walletBalance });
  } catch (err) {
    console.error("Wallet verify error:", err);
    return res.status(500).json({ message: "Wallet verification failed" });
  }
};

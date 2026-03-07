import Razorpay from "razorpay";
import crypto from "crypto";
import User from "../models/User.js";
import {
  consumeWalletOrderSession,
  getWalletOrderSession,
  saveWalletOrderSession,
} from "../services/payment.session.service.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const toIdString = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (typeof v.toHexString === "function") return v.toHexString();
    if (typeof v.$oid === "string") return v.$oid;
    if (typeof v.id === "string") return v.id;
    if (v._id) return toIdString(v._id);
  }
  return String(v);
};

const secureEqual = (a, b) => {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
};

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

    const normalizedAmount = Math.round(amount * 100);
    const order = await razorpay.orders.create({
      amount: normalizedAmount,
      currency: "INR",
      receipt: `wallet_${String(req.user.userId).slice(-8)}_${Date.now()}`,
      payment_capture: 1,
    });

    await saveWalletOrderSession(order.id, {
      userId: toIdString(req.user.userId),
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      createdAt: new Date().toISOString(),
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

    if (!secureEqual(expectedSignature, razorpay_signature)) {
      return res.status(400).json({ message: "Invalid signature" });
    }

    const pending = await getWalletOrderSession(razorpay_order_id);
    if (!pending) {
      return res.status(400).json({ message: "Wallet top-up session expired or invalid" });
    }

    if (toIdString(pending.userId) !== toIdString(req.user.userId)) {
      return res.status(403).json({ message: "Wallet top-up session does not belong to user" });
    }

    const [rzpOrder, rzpPayment] = await Promise.all([
      razorpay.orders.fetch(razorpay_order_id),
      razorpay.payments.fetch(razorpay_payment_id),
    ]);

    if (!rzpOrder || rzpOrder.id !== razorpay_order_id) {
      return res.status(400).json({ message: "Invalid Razorpay order" });
    }

    if (!rzpPayment || rzpPayment.order_id !== razorpay_order_id) {
      return res.status(400).json({ message: "Payment/order mismatch" });
    }

    if ((rzpOrder.amount || 0) !== (Number(pending.amount) || 0)) {
      return res.status(400).json({ message: "Order amount mismatch" });
    }

    if ((rzpPayment.amount || 0) !== (Number(pending.amount) || 0)) {
      return res.status(400).json({ message: "Paid amount mismatch" });
    }

    if (String(rzpPayment.status || "").toLowerCase() !== "captured") {
      return res.status(400).json({ message: "Payment is not captured" });
    }

    await consumeWalletOrderSession(razorpay_order_id);

    const creditAmount = Math.max(0, (rzpPayment.amount || 0) / 100);
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

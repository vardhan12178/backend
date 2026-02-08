import Razorpay from "razorpay";
import crypto from "crypto";
import User from "../models/User.js";
import MembershipPlan from "../models/MembershipPlan.js";
import redis from "../utils/redis.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export const getPlans = async (req, res) => {
  try {
    const plans = await MembershipPlan.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean();
    res.json(plans);
  } catch (err) {
    console.error("Get plans error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("membership");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ membership: user.membership, isPrime: user.isPrime });
  } catch (err) {
    console.error("Get membership status error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const purchasePlan = async (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ message: "planId is required" });

    const plan = await MembershipPlan.findById(planId);
    if (!plan || !plan.isActive)
      return res.status(404).json({ message: "Plan not found" });

    const order = await razorpay.orders.create({
      amount: Math.round(plan.price * 100),
      currency: plan.currency || "INR",
      receipt: `pr_${String(req.user.userId).slice(-8)}_${Date.now()}`,
      payment_capture: 1,
    });

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      plan: {
        name: plan.name,
        durationDays: plan.durationDays,
        price: plan.price,
      },
    });
  } catch (err) {
    console.error("Membership purchase error:", err);
    res.status(500).json({ message: "Failed to create payment order" });
  }
};

export const verifyAndActivate = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !planId
    ) {
      return res.status(400).json({ message: "Missing payment fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid signature" });
    }

    const plan = await MembershipPlan.findById(planId);
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const alreadyUsed = (user.membership?.history || []).some(
      (h) => h.paymentId === razorpay_payment_id
    );
    if (alreadyUsed) {
      return res.json({
        success: true,
        membership: user.membership,
        isPrime: user.isPrime,
      });
    }

    const now = new Date();
    const currentEnd =
      user.membership?.endDate && new Date(user.membership.endDate) > now
        ? new Date(user.membership.endDate)
        : now;
    const newEnd = new Date(
      currentEnd.getTime() + plan.durationDays * 24 * 60 * 60 * 1000
    );

    user.membership = {
      plan: plan.name,
      planId: plan._id,
      startDate:
        user.membership?.startDate &&
        new Date(user.membership.startDate) <= now
          ? user.membership.startDate
          : now,
      endDate: newEnd,
      paymentId: razorpay_payment_id,
      history: [
        ...(user.membership?.history || []),
        {
          plan: plan.name,
          startDate: currentEnd,
          endDate: newEnd,
          paymentId: razorpay_payment_id,
          amount: plan.price,
        },
      ],
    };

    await user.save();

    // Clear profile cache so isPrime updates immediately
    try {
      await redis.del(`profile:${user._id}`);
    } catch (e) {
      console.warn("Redis del profile cache error:", e.message);
    }

    res.json({
      success: true,
      membership: user.membership,
      isPrime: user.isPrime,
    });
  } catch (err) {
    console.error("Membership verify error:", err);
    res.status(500).json({ message: "Membership activation failed" });
  }
};

export const adminListPlans = async (req, res) => {
  try {
    const plans = await MembershipPlan.find().sort({ sortOrder: 1 }).lean();
    res.json(plans);
  } catch (err) {
    console.error("Admin list plans error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const adminCreatePlan = async (req, res) => {
  try {
    const plan = await MembershipPlan.create(req.body);
    res.status(201).json(plan);
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ message: "Plan slug already exists" });
    console.error("Create plan error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const adminUpdatePlan = async (req, res) => {
  try {
    const plan = await MembershipPlan.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    res.json(plan);
  } catch (err) {
    console.error("Update plan error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const adminDeletePlan = async (req, res) => {
  try {
    const plan = await MembershipPlan.findByIdAndDelete(req.params.id);
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    res.json({ message: "Plan deleted" });
  } catch (err) {
    console.error("Delete plan error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

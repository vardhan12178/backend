import Coupon from "../models/Coupon.js";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Admin CRUD ───────────────────────────────────────────────────────────────

export const createCoupon = async (req, res) => {
  try {
    const { code, description, type, value, maxDiscount, minOrder, usageLimit, perUserLimit, validFrom, validTo, isPublic } = req.body;

    if (!code || !type || value == null || !validTo) {
      return res.status(400).json({ message: "code, type, value, and validTo are required" });
    }

    if (type === "percent" && (value < 1 || value > 100)) {
      return res.status(400).json({ message: "Percent value must be between 1 and 100" });
    }

    const existing = await Coupon.findOne({ code: code.toUpperCase().trim() });
    if (existing) return res.status(409).json({ message: "Coupon code already exists" });

    const coupon = await Coupon.create({
      code: code.toUpperCase().trim(),
      description,
      type,
      value,
      maxDiscount: maxDiscount || null,
      minOrder: minOrder || 0,
      usageLimit: usageLimit || null,
      perUserLimit: perUserLimit || 1,
      validFrom: validFrom || new Date(),
      validTo,
      isPublic: !!isPublic,
    });

    res.status(201).json({ message: "Coupon created", coupon });
  } catch (err) {
    console.error("Create coupon error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const listCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    res.json({ coupons });
  } catch (err) {
    console.error("List coupons error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const updateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    delete updates._id;
    delete updates.usedCount;
    delete updates.usedBy;

    if (updates.code) updates.code = updates.code.toUpperCase().trim();

    if (updates.type === "percent" && updates.value != null && (updates.value < 1 || updates.value > 100)) {
      return res.status(400).json({ message: "Percent value must be between 1 and 100" });
    }

    const coupon = await Coupon.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!coupon) return res.status(404).json({ message: "Coupon not found" });

    res.json({ message: "Coupon updated", coupon });
  } catch (err) {
    console.error("Update coupon error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ message: "Coupon not found" });
    res.json({ message: "Coupon deleted" });
  } catch (err) {
    console.error("Delete coupon error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── User-facing ──────────────────────────────────────────────────────────────

export const getPublicCoupons = async (_req, res) => {
  try {
    const now = new Date();
    const coupons = await Coupon.find({
      isActive: true,
      isPublic: true,
      validFrom: { $lte: now },
      validTo: { $gte: now },
      $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
    })
      .select("code description type value maxDiscount minOrder validTo")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ coupons });
  } catch (err) {
    console.error("Get public coupons error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const validateCoupon = async (req, res) => {
  try {
    const { code, subtotal } = req.body;
    if (!code) return res.status(400).json({ message: "Coupon code is required" });

    const result = await applyCoupon(code, Number(subtotal) || 0, req.user.userId);
    if (!result.valid) return res.status(400).json({ message: result.reason });

    res.json({
      valid: true,
      code: result.coupon.code,
      type: result.coupon.type,
      value: result.coupon.value,
      discount: result.discount,
      description: result.coupon.description,
    });
  } catch (err) {
    console.error("Validate coupon error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── Shared validation logic (used by order controller too) ───────────────────

export async function applyCoupon(code, subtotal, userId) {
  const now = new Date();
  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });

  if (!coupon) return { valid: false, reason: "Coupon not found" };
  if (!coupon.isActive) return { valid: false, reason: "Coupon is no longer active" };
  if (now < coupon.validFrom) return { valid: false, reason: "Coupon is not yet valid" };
  if (now > coupon.validTo) return { valid: false, reason: "Coupon has expired" };

  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, reason: "Coupon usage limit reached" };
  }

  if (userId && coupon.perUserLimit) {
    const userEntry = coupon.usedBy.find((u) => u.userId.toString() === userId.toString());
    if (userEntry && userEntry.count >= coupon.perUserLimit) {
      return { valid: false, reason: "You have already used this coupon" };
    }
  }

  if (subtotal < coupon.minOrder) {
    return { valid: false, reason: `Minimum order of ₹${coupon.minOrder} required` };
  }

  let discount = 0;
  if (coupon.type === "percent") {
    discount = round2(subtotal * (coupon.value / 100));
    if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
  } else {
    discount = Math.min(round2(coupon.value), subtotal);
  }

  return { valid: true, coupon, discount };
}

// Track usage after order is placed successfully
export async function recordCouponUsage(code, userId) {
  if (!code) return;
  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
  if (!coupon) return;

  const userEntry = coupon.usedBy.find((u) => u.userId.toString() === userId.toString());
  if (userEntry) {
    userEntry.count += 1;
  } else {
    coupon.usedBy.push({ userId, count: 1 });
  }
  coupon.usedCount += 1;
  await coupon.save();
}

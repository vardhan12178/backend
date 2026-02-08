import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    description: { type: String, trim: true, default: "" },

    // "percent" = X% off, "flat" = ₹X off
    type: {
      type: String,
      enum: ["percent", "flat"],
      required: true,
    },

    value: { type: Number, required: true, min: 0 },

    // For percent coupons: cap the max discount amount
    maxDiscount: { type: Number, min: 0, default: null },

    // Minimum cart subtotal required to use this coupon
    minOrder: { type: Number, min: 0, default: 0 },

    // Global usage cap (null = unlimited)
    usageLimit: { type: Number, min: 0, default: null },

    // How many times this coupon has been used total
    usedCount: { type: Number, min: 0, default: 0 },

    // Max uses per individual user (null = unlimited)
    perUserLimit: { type: Number, min: 1, default: 1 },

    // Track which users have used this coupon and how many times
    usedBy: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        count: { type: Number, default: 1 },
      },
    ],

    // Validity window
    validFrom: { type: Date, default: () => new Date() },
    validTo: { type: Date, required: true },

    // Show to users on checkout (public coupons)
    isPublic: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false }
);

couponSchema.index({ isActive: 1, validTo: 1 });

const Coupon = mongoose.model("Coupon", couponSchema);
export default Coupon;

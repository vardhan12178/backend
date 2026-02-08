import mongoose from "mongoose";

const { Schema } = mongoose;

const membershipPlanSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    durationDays: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, min: 0 },
    currency: { type: String, default: "INR" },
    features: [{ type: String, trim: true }],
    isPopular: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

membershipPlanSchema.index({ isActive: 1, sortOrder: 1 });

const MembershipPlan = mongoose.model("MembershipPlan", membershipPlanSchema);
export default MembershipPlan;

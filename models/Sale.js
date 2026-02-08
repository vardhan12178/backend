import mongoose from "mongoose";

const { Schema } = mongoose;

const categoryDiscountSchema = new Schema(
  {
    category: { type: String, required: true, trim: true },
    discountPercent: { type: Number, required: true, min: 1, max: 95 },
    primeDiscountPercent: { type: Number, min: 0, max: 95, default: 0 },
  },
  { _id: false }
);

const saleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: { type: String, trim: true, maxlength: 500 },
    bannerImage: { type: String, trim: true },
    categories: {
      type: [categoryDiscountSchema],
      validate: {
        validator: (arr) => arr.length > 0,
        message: "A sale must include at least one category discount.",
      },
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

saleSchema.virtual("isCurrentlyActive").get(function () {
  if (!this.isActive) return false;
  const now = new Date();
  return now >= this.startDate && now <= this.endDate;
});

saleSchema.index({ startDate: 1, endDate: 1 });
saleSchema.index({ "categories.category": 1 });

const Sale = mongoose.model("Sale", saleSchema);
export default Sale;

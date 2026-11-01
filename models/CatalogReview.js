import mongoose from "mongoose";

// A review written by a shopper who received the product. One per shopper per product.
const catalogReviewSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "CatalogProduct", required: true },
    slug: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    // Shown publicly: first name and last initial only
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    variant: { type: String, trim: true, maxlength: 160 },
    stars: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 80, default: "" },
    body: { type: String, required: true, trim: true, minlength: 10, maxlength: 1500 },
    status: { type: String, enum: ["published", "hidden"], default: "published", index: true },
    helpfulBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true, collection: "catalog_user_reviews" }
);

catalogReviewSchema.index({ productId: 1, userId: 1 }, { unique: true });
catalogReviewSchema.index({ productId: 1, status: 1, createdAt: -1 });

export default mongoose.models.CatalogReview || mongoose.model("CatalogReview", catalogReviewSchema);

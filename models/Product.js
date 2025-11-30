import mongoose from "mongoose";
const { Schema } = mongoose;

/* ------------ Review Subdocument ------------ */
const reviewSchema = new Schema(
  {
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true },
    reviewerName: { type: String, trim: true },
    reviewerEmail: { type: String, trim: true },
    date: { type: Date, default: Date.now },
    userId: { type: Schema.Types.ObjectId, ref: "User" }, // for verified purchase
  },
  { _id: true }
);

/* ------------ Dimensions ------------ */
const dimSchema = new Schema(
  {
    width: Number,
    height: Number,
    depth: Number,
  },
  { _id: false }
);

/* ------------ Metadata ------------ */
const metaSchema = new Schema(
  {
    barcode: { type: String, trim: true },
    qrCode: { type: String, trim: true },
    createdAt: String,
    updatedAt: String,
  },
  { _id: false }
);

/* ------------ Main Product Schema ------------ */
const productSchema = new Schema(
  {
    // Basic
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    brand: { type: String, trim: true },

    // Pricing
    price: { type: Number, required: true, min: 0 },
    discountPercentage: { type: Number, min: 0, max: 90, default: 0 },
    rating: { type: Number, min: 0, max: 5, default: 0 },

    // Inventory
    stock: { type: Number, required: true, min: 0 },
    minimumOrderQuantity: { type: Number, min: 1, default: 1 },

    // Identifiers
    sku: { type: String, trim: true },
    tags: [{ type: String, trim: true }],

    // Physical
    weight: Number,
    dimensions: dimSchema,

    // Logistics
    warrantyInformation: { type: String, trim: true },
    shippingInformation: { type: String, trim: true },
    availabilityStatus: { type: String, trim: true },
    returnPolicy: { type: String, trim: true },

    // Media
    thumbnail: { type: String, required: true, trim: true },
    images: [{ type: String, trim: true }],

    // Reviews
    reviews: [reviewSchema],

    // Metadata
    meta: metaSchema,

    // Admin controls
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/* ------------ Indexes for Performance Optimization ------------ */

/**
 * Compound index for active products with category filtering
 * Optimizes queries like: { isActive: true, category: 'electronics' }
 * This is the primary index for most product list queries
 */
productSchema.index({ isActive: 1, category: 1 });

/**
 * Compound index for active products with price filtering and sorting
 * Optimizes queries like: { isActive: true, price: { $gte: 100, $lte: 500 } }
 * Also supports sorting by price
 */
productSchema.index({ isActive: 1, price: 1 });

/**
 * Compound index for active products with rating filtering and sorting
 * Optimizes queries like: { isActive: true, rating: { $gte: 4 } }
 * Also supports sorting by rating (descending)
 */
productSchema.index({ isActive: 1, rating: -1 });

/**
 * Full-text search index for product title and description
 * Enables text search queries using $text operator
 */
productSchema.index({ title: "text", description: "text" });

/**
 * Index for sorting by creation date (newest first)
 * Optimizes "newest" sort queries
 */
productSchema.index({ createdAt: -1 });

/**
 * Sparse index for SKU lookups
 * Only indexes documents that have a SKU field
 * Useful for admin panel SKU searches
 */
productSchema.index({ sku: 1 }, { sparse: true });

export default mongoose.model("Product", productSchema);
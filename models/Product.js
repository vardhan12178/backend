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
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    isHidden: { type: Boolean, default: false },
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
    isIndianized: { type: Boolean, default: false },
    originalData: {
      type: mongoose.Schema.Types.Mixed, // Allows storing the full old object
      select: false // Hides it from frontend
    },
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

    // Variants (e.g. Size, Color, Storage)
    variants: [
      {
        type: { type: String, trim: true },
        options: [{ type: String, trim: true }],
        _id: false,
      },
    ],

    // Metadata
    meta: metaSchema,

    // Admin controls
    isActive: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },

    // --- AI Vector Search Integration ---
    /**
     * Stores the vector embedding (array of numbers) for semantic search.
     * select: false -> Prevents this heavy field from being sent in normal API calls,
     * ensuring no performance impact on your existing frontend apps.
     */
    embedding: {
      type: [Number],
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/* ------------ Indexes for Performance Optimization ------------ */

// Active + Category (Primary Browse Filter)
productSchema.index({ isActive: 1, category: 1 });

// Active + Price (Range Filter & Sort)
productSchema.index({ isActive: 1, price: 1 });

// Active + Rating (Quality Filter)
productSchema.index({ isActive: 1, rating: -1 });

// Standard Text Search (Keyword Fallback)
productSchema.index({ title: "text", description: "text" });

// Newest Arrivals
productSchema.index({ createdAt: -1 });

// Relevance (Featured + Rating + Newest)
productSchema.index({ isActive: 1, isFeatured: -1, rating: -1, createdAt: -1 });

// Admin Lookup
productSchema.index({ sku: 1 }, { sparse: true });

export default mongoose.model("Product", productSchema);

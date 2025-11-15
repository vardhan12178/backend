import mongoose from "mongoose";

// -----------------------------------------------------------------------------
// ORDER STAGES (Modern E-Commerce Pipeline)
// -----------------------------------------------------------------------------
export const STAGES = [
  "PLACED",
  "CONFIRMED",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
];

const TAX_RATE = 0.18;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// -----------------------------------------------------------------------------
// PRODUCT LINE ITEM SCHEMA
// -----------------------------------------------------------------------------
const productLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    externalId: { type: String },

    name: { type: String, required: true, trim: true },
    image: { type: String, trim: true },

    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: "Quantity must be an integer" },
      set: (v) => Math.trunc(v),
    },

    price: { type: Number, required: true, min: 0, set: round2 },

    // auto-calculated per line
    lineTotal: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

// -----------------------------------------------------------------------------
// ORDER SCHEMA
// -----------------------------------------------------------------------------
const orderSchema = new mongoose.Schema(
  {
    // USER METADATA
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Snapshot customer details (to prevent mismatch on profile change)
    customer: {
      name: { type: String, trim: true },
      email: { type: String, trim: true },
      phone: { type: String, trim: true },
    },

    // ORDER ITEMS
    products: {
      type: [productLineSchema],
      required: true,
      validate: {
        validator: (arr) =>
          Array.isArray(arr) &&
          arr.length > 0 &&
          arr.every((p) => p && (p.productId || p.externalId)),
        message: "Each product must include productId or externalId.",
      },
    },

    // PRICING
    subtotal: { type: Number, min: 0, default: 0, set: round2 },
    tax: { type: Number, min: 0, default: 0, set: round2 },
    shipping: { type: Number, min: 0, default: 0, set: round2 },
    totalPrice: { type: Number, required: true, min: 0.01, set: round2 },
    currency: { type: String, default: "INR" },

    // ORDER ID (HUMAN READABLE)
    orderId: { type: String, unique: true, index: true },

    // PAYMENT INFO
    paymentStatus: {
      type: String,
      enum: ["PAID", "PENDING", "FAILED"],
      default: "PENDING",
    },

    paymentMethod: {
      type: String,
      enum: ["CARD", "UPI", "COD", "WALLET"],
      default: "COD",
    },

    // SHIPPING
    shippingAddress: { type: String, required: true, trim: true },

    // Optional promo
    promo: { type: String, trim: true },

    // ORDER STAGE
    stage: { type: String, enum: STAGES, default: "PLACED", index: true },

    // FULL TIMELINE / HISTORY
    statusHistory: [
      {
        stage: { type: String, enum: STAGES },
        date: { type: Date, default: () => new Date() },
        note: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true, versionKey: false }
);

// -----------------------------------------------------------------------------
// INDEXES
// -----------------------------------------------------------------------------
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ stage: 1 });
orderSchema.index({ createdAt: -1 });

// -----------------------------------------------------------------------------
// PRE-VALIDATION HOOK (AUTO-CALCULATIONS)
// -----------------------------------------------------------------------------
orderSchema.pre("validate", function (next) {
  // Normalize stage
  if (typeof this.stage === "string") {
    this.stage = this.stage.toUpperCase();
    if (!STAGES.includes(this.stage)) this.stage = "PLACED";
  } else {
    this.stage = "PLACED";
  }

  // Generate Order ID
  if (!this.orderId) {
    this.orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }

  const safeProducts = Array.isArray(this.products) ? this.products : [];

  // Calculate line totals
  safeProducts.forEach((p) => {
    const qty = Math.max(0, Math.trunc(Number(p.quantity) || 0));
    const price = round2(p.price);
    p.lineTotal = round2(qty * price);
  });

  // Totals
  this.subtotal = round2(safeProducts.reduce((sum, p) => sum + p.lineTotal, 0));
  this.shipping = round2(this.shipping ?? 0);
  this.tax = round2(this.subtotal * TAX_RATE);
  this.totalPrice = round2(this.subtotal + this.tax + this.shipping);

  // Add initial history entry
  if (this.isNew) {
    this.statusHistory.push({ stage: this.stage });
  }

  next();
});

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const Order = mongoose.model("Order", orderSchema);
Order.STAGES = STAGES;

export default Order;

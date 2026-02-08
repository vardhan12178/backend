import mongoose from "mongoose";
import mongooseSequence from "mongoose-sequence";

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
const AutoIncrement = mongooseSequence(mongoose);

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

    // Optional variant selection (e.g. "Size: L, Color: Red")
    selectedVariants: { type: String, trim: true },

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
    discount: { type: Number, min: 0, default: 0, set: round2 },
    tax: { type: Number, min: 0, default: 0, set: round2 },
    shipping: { type: Number, min: 0, default: 0, set: round2 },
    totalPrice: { type: Number, required: true, min: 0.01, set: round2 },
    currency: { type: String, default: "INR" },

    // ORDER ID (HUMAN READABLE)
    orderId: { type: String, unique: true, index: true },
    invoiceSeq: { type: Number, index: true },
    invoiceNumber: { type: String, unique: true, index: true },

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

    paymentId: { type: String, trim: true },
    paymentOrderId: { type: String, trim: true },
    walletUsed: { type: Number, min: 0, default: 0 },

    // SHIPPING
    shippingAddress: { type: String, required: true, trim: true },

    // Optional promo
    promo: { type: String, trim: true },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon" },

    // Sale & membership discounts
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale" },
    saleName: { type: String, trim: true },
    saleDiscount: { type: Number, min: 0, default: 0, set: round2 },
    membershipDiscount: { type: Number, min: 0, default: 0, set: round2 },

    // ORDER STAGE
    stage: { type: String, enum: STAGES, default: "PLACED", index: true },

    // RETURNS / REFUNDS
    returnStatus: {
      type: String,
      enum: [
        "NONE",
        "REQUESTED",
        "APPROVED",
        "PICKED",
        "RECEIVED",
        "REJECTED",
        "CLOSED",
      ],
      default: "NONE",
    },
    returnType: { type: String, enum: ["REFUND", "REPLACEMENT"], default: "REFUND" },
    returnReason: { type: String, trim: true },
    replacementOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    replacementFromId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    returnHistory: [
      {
        status: { type: String },
        date: { type: Date, default: () => new Date() },
        note: { type: String, trim: true },
      },
    ],

    refundStatus: {
      type: String,
      enum: ["NONE", "INITIATED", "COMPLETED", "FAILED"],
      default: "NONE",
    },
    refundMethod: { type: String, enum: ["WALLET", "ORIGINAL"] },
    refundAmount: { type: Number, min: 0, default: 0 },
    refundDueAt: { type: Date },

    cancelReason: { type: String, trim: true },

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
  this.discount = round2(this.discount ?? 0);
  this.saleDiscount = round2(this.saleDiscount ?? 0);
  this.membershipDiscount = round2(this.membershipDiscount ?? 0);
  this.shipping = round2(this.shipping ?? 0);

  const totalDiscount = round2(this.discount + this.saleDiscount + this.membershipDiscount);
  this.tax = round2(Math.max(0, this.subtotal - totalDiscount) * TAX_RATE);
  this.totalPrice = round2(Math.max(0.01, this.subtotal - totalDiscount + this.tax + this.shipping));

  // Add initial history entry
  if (this.isNew) {
    this.statusHistory.push({ stage: this.stage });
  }

  next();
});

orderSchema.plugin(AutoIncrement, { inc_field: "invoiceSeq", start_seq: 1 });

orderSchema.post("save", async function (doc) {
  if (!doc.invoiceNumber && doc.invoiceSeq) {
    const year = new Date(doc.createdAt || Date.now()).getFullYear();
    const invoice = `INV-${year}-${String(doc.invoiceSeq).padStart(6, "0")}`;
    await doc.constructor.updateOne({ _id: doc._id }, { invoiceNumber: invoice });
    doc.invoiceNumber = invoice;
  }
});

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const Order = mongoose.model("Order", orderSchema);
Order.STAGES = STAGES;

export default Order;

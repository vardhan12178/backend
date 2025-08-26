const mongoose = require('mongoose');

const STAGES = ['PLACED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const TAX_RATE = 0.18;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const productLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    externalId: { type: String },
    name: { type: String, required: true, trim: true },
    image: { type: String, trim: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'Quantity must be an integer' },
      set: (v) => Math.trunc(v),
    },
    price: { type: Number, required: true, min: 0, set: round2 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    products: {
      type: [productLineSchema],
      required: true,
      validate: {
        validator: (arr) =>
          Array.isArray(arr) && arr.length > 0 && arr.every((p) => p && (p.productId || p.externalId)),
        message: 'Each product must include productId or externalId, and products cannot be empty.',
      },
    },
    subtotal: { type: Number, min: 0, default: 0, set: round2 },
    tax: { type: Number, min: 0, default: 0, set: round2 },
    shipping: { type: Number, min: 0, default: 0, set: round2 },
    totalPrice: { type: Number, required: true, min: 0.01, set: round2 },
    stage: { type: String, enum: STAGES, default: 'PLACED', index: true },
    shippingAddress: { type: String, required: true, trim: true },
    promo: { type: String, trim: true },
    currency: { type: String, default: 'INR' },
  },
  { timestamps: true, versionKey: false }
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

orderSchema.pre('validate', function (next) {
  if (typeof this.stage === 'string') {
    this.stage = this.stage.toUpperCase();
    if (!STAGES.includes(this.stage)) this.stage = 'PLACED';
  } else {
    this.stage = 'PLACED';
  }

  const safeProducts = Array.isArray(this.products) ? this.products : [];
  const perLineTotals = safeProducts.map((p) => {
    const qty = Math.max(0, Math.trunc(Number(p.quantity) || 0));
    const price = round2(p.price);
    return round2(qty * price);
  });

  const computedSubtotal = round2(perLineTotals.reduce((a, b) => a + b, 0));
  this.subtotal = computedSubtotal;

  const shipping = round2(this.shipping ?? 0);
  this.shipping = shipping;

  const computedTax = round2(this.subtotal * TAX_RATE);
  this.tax = computedTax;

  this.totalPrice = round2(this.subtotal + this.tax + this.shipping);

  next();
});

const Order = mongoose.model('Order', orderSchema);
Order.STAGES = STAGES;
module.exports = Order;

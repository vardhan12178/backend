const mongoose = require('mongoose');

const STAGES = ['PLACED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

const productLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    externalId: { type: String },
    name: { type: String, required: true, trim: true },
    image: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    products: {
      type: [productLineSchema],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0 && arr.every(p => p.productId || p.externalId),
        message: 'Each product must include productId or externalId, and products cannot be empty.'
      },
      required: true
    },
    subtotal: { type: Number, min: 0 },
    tax: { type: Number, min: 0 },
    totalPrice: { type: Number, required: true, min: 0 },
    stage: { type: String, enum: STAGES, default: 'PLACED', index: true },
    shippingAddress: { type: String, required: true, trim: true },
    promo: { type: String, trim: true }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);

// models/Order.js
const mongoose = require('mongoose');

const productLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, 
    externalId: { type: String },                                         
    name: { type: String, required: true },
    image: String,
    quantity: { type: Number, required: true, min: 1 },
    price:    { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  products: {
    type: [productLineSchema],
    validate: {
      validator: (arr) => arr.every(p => p.productId || p.externalId),
      message: 'Each product must include productId (Mongo) or externalId (DummyJSON).'
    }
  },
  subtotal:   { type: Number }, // optional if you store it
  tax:        { type: Number }, // optional
  totalPrice: { type: Number, required: true },
  stage: { type: String, required: true, default: 'pending' },
  shippingAddress: { type: String, required: true },
  promo: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', orderSchema);

const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  products: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    image: String,
    quantity: Number,
    price: Number
  }],
  totalPrice: { type: Number, required: true },
  stage: { type: String, required: true },
  shippingAddress: { type: String, required: true }
});

module.exports = mongoose.model('Order', orderSchema);

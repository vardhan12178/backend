const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  products: [{
    productId: mongoose.Schema.Types.ObjectId,
    name: String,
    image: String,
    quantity: Number,
    price: Number
  }],
  totalPrice: Number,
  stage: String,
  shippingAddress: String,
  paymentMethod: String,
  upiId: String
});

module.exports = mongoose.model('Order', orderSchema);

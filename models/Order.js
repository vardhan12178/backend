const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const orderSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  products: [{ productId: String, quantity: Number }],
  totalPrice: Number,
  stage: String,
  shippingAddress: String,
  paymentMethod: String,
  upiId: String,
});

module.exports = mongoose.model('Order', orderSchema);

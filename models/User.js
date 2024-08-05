const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: String,
  username: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String,
  profileImage: String,
  orders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  }]
});


module.exports = mongoose.model('User', userSchema);


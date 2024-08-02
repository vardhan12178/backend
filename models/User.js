const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  profileImage: { type: String },  
  orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],  
});

module.exports = mongoose.model('User', userSchema);

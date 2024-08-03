const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: String,
  username: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String,
  profilePicture: { type: String, default: 'default-profile.png' }
});

module.exports = mongoose.model('User', userSchema);

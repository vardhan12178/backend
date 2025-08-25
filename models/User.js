const mongoose = require('mongoose');
const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 64,
      match: /^[a-z0-9._-]+$/i
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    },
    password: { type: String, required: true, select: false },
    profileImage: { type: String, trim: true },
    orders: [{ type: Schema.Types.ObjectId, ref: 'Order' }]
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        return ret;
      }
    }
  }
);

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });

userSchema.pre('save', function (next) {
  if (this.isModified('email') && this.email) this.email = this.email.toLowerCase().trim();
  if (this.isModified('username') && this.username) this.username = this.username.toLowerCase().trim();
  next();
});

module.exports = mongoose.model('User', userSchema);

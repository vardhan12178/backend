const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
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
    orders: [{ type: Schema.Types.ObjectId, ref: 'Order' }],
    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpiresAt: { type: Date }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.resetPasswordTokenHash;
        return ret;
      }
    },
    toObject: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.resetPasswordTokenHash;
        return ret;
      }
    }
  }
);

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ createdAt: -1 });

userSchema.pre('save', function (next) {
  if (this.isModified('email') && this.email) this.email = this.email.toLowerCase().trim();
  if (this.isModified('username') && this.username) this.username = this.username.toLowerCase().trim();
  next();
});

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.statics.findForLogin = function (identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  return this.findOne({ $or: [{ username: id }, { email: id }] }).select('+password');
};

module.exports = mongoose.model('User', userSchema);

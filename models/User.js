import mongoose from "mongoose";
import bcrypt from "bcryptjs";

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
      match: /^[a-z0-9._-]+$/i,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },

    password: { type: String, required: true, select: false },
    profileImage: { type: String, trim: true },
    orders: [{ type: Schema.Types.ObjectId, ref: "Order" }],

    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpiresAt: { type: Date },

    /* ---------- Email Verification ---------- */
    emailVerified: { type: Boolean, default: false },
    emailVerifyTokenHash: { type: String, select: false },
    emailVerifyExpiresAt: { type: Date },

    /* ---------- Two-Factor Authentication ---------- */
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecretEnc: { type: String, select: false },
    twoFactorSecret: { type: String, select: false },
    suppress2faPrompt: { type: Boolean, default: false },
    twoFactorBackupCodes: [{ type: String, select: false }],

    /* ---------- Admin Block Feature (NEW) ---------- */
    blocked: { type: Boolean, default: false },

    /* ---------- Roles (User can be both) ---------- */
    roles: {
      type: [String],
      enum: ["user", "admin"],
      default: ["user"],
    },

    /* ---------- Cart & Wishlist ---------- */
    cart: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product" },
        externalId: { type: String },
        title: { type: String, trim: true },
        price: { type: Number, min: 0 },
        quantity: { type: Number, min: 1, default: 1 },
        thumbnail: { type: String, trim: true },
        category: { type: String, trim: true },
        discountPercentage: { type: Number, min: 0, max: 90 },
        selectedVariants: { type: String, trim: true },
      },
    ],

    wishlist: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product" },
        externalId: { type: String },
        title: { type: String, trim: true },
        price: { type: Number, min: 0 },
        thumbnail: { type: String, trim: true },
        category: { type: String, trim: true },
        discountPercentage: { type: Number, min: 0, max: 90 },
      },
    ],

    /* ---------- Addresses ---------- */
    addresses: [
      {
        label: { type: String, trim: true },
        fullName: { type: String, trim: true },
        phone: { type: String, trim: true },
        email: { type: String, trim: true },
        address1: { type: String, trim: true },
        address2: { type: String, trim: true },
        city: { type: String, trim: true },
        state: { type: String, trim: true },
        pincode: { type: String, trim: true },
        country: { type: String, trim: true, default: "India" },
        isDefault: { type: Boolean, default: false },
      },
    ],

    /* ---------- Wallet ---------- */
    walletBalance: { type: Number, default: 0, min: 0 },
    walletTransactions: [
      {
        type: { type: String, enum: ["CREDIT", "DEBIT"] },
        amount: { type: Number, min: 0 },
        reason: { type: String, trim: true },
        orderId: { type: Schema.Types.ObjectId, ref: "Order" },
        paymentId: { type: String, trim: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    /* ---------- Prime Membership ---------- */
    membership: {
      plan: { type: String, trim: true },
      planId: { type: Schema.Types.ObjectId, ref: "MembershipPlan" },
      startDate: { type: Date },
      endDate: { type: Date },
      paymentId: { type: String, trim: true },
      history: [
        {
          plan: { type: String, trim: true },
          startDate: { type: Date },
          endDate: { type: Date },
          paymentId: { type: String, trim: true },
          amount: { type: Number, min: 0 },
          createdAt: { type: Date, default: Date.now },
        },
      ],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.password;
        delete ret.resetPasswordTokenHash;
        delete ret.emailVerifyTokenHash;
        delete ret.twoFactorSecretEnc;
        delete ret.twoFactorSecret;
        delete ret.twoFactorBackupCodes;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.password;
        delete ret.resetPasswordTokenHash;
        delete ret.emailVerifyTokenHash;
        delete ret.twoFactorSecretEnc;
        delete ret.twoFactorSecret;
        delete ret.twoFactorBackupCodes;
        return ret;
      },
    },
  }
);


userSchema.virtual("isPrime").get(function () {
  if (!this.membership || !this.membership.endDate) return false;
  return new Date() < this.membership.endDate;
});

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ createdAt: -1 });

userSchema.pre("save", function (next) {
  if (this.isModified("email") && this.email)
    this.email = this.email.toLowerCase().trim();
  if (this.isModified("username") && this.username)
    this.username = this.username.toLowerCase().trim();
  next();
});

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.statics.findForLogin = function (identifier) {
  const id = String(identifier || "").trim().toLowerCase();
  return this.findOne({ $or: [{ username: id }, { email: id }] }).select("+password");
};

const User = mongoose.model("User", userSchema);
export default User;

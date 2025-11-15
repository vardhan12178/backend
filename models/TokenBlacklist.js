import mongoose from "mongoose";

const tokenBlacklistSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  expiredAt: { type: Date, required: true },
});


tokenBlacklistSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("TokenBlacklist", tokenBlacklistSchema);

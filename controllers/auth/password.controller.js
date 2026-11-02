import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendEmail, emailTemplate } from "../../services/email.service.js";
import User from "../../models/User.js";
import { buildClearCookieOpts } from "../../utils/cookies.js";
import { APP_URL } from "./shared.js";

// Forgot Password
export const forgotPassword = async (req, res) => {
  try {
    const raw = (req.body.emailOrUsername || "").toString().trim().toLowerCase();
    if (!raw) return res.json({ message: "If an account exists, a reset link was sent." });

    const user = await User.findOne({ $or: [{ email: raw }, { username: raw }] });
    if (user?.email) {
      const tokenRaw = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(tokenRaw).digest("hex");
      user.resetPasswordTokenHash = tokenHash;
      user.resetPasswordExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();

      const link = `${APP_URL}/reset-password?token=${tokenRaw}`;

      try {
        await sendEmail({
          to: user.email,
          subject: "VKart password reset",
          html: emailTemplate({
            title: "Reset your password",
            body: "Click the link below to reset your password. The link expires in 30 minutes.",
            ctaLabel: "Reset Password",
            ctaUrl: link,
          }),
        });
      } catch {
        console.warn("Email send skipped in test env");
      }
    }
    res.json({ message: "If an account exists, a reset link was sent." });
  } catch {
    res.json({ message: "If an account exists, a reset link was sent." });
  }
};

// Reset Password
export const resetPassword = async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token || !password || !confirmPassword)
      return res.status(400).json({ message: "Invalid payload" });
    if (password !== confirmPassword)
      return res.status(400).json({ message: "Passwords do not match" });
    if (password.length < 8) return res.status(400).json({ message: "Use at least 8 characters" });

    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() },
    }).select("+password");

    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    user.password = await bcrypt.hash(password, 11);
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpiresAt = undefined;
    await user.save();

    res.clearCookie("jwt_token", buildClearCookieOpts(req));
    res.json({ message: "Password reset successful" });
  } catch {
    res.status(500).json({ message: "Internal server error" });
  }
};

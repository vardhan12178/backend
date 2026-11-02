import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendEmail, emailTemplate } from "../../services/email.service.js";
import User from "../../models/User.js";
import { createNotification } from "../admin.notifications.controller.js";
import { APP_URL } from "./shared.js";

const createEmailVerifyToken = () => {
  const tokenRaw = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(tokenRaw).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return { tokenRaw, tokenHash, expiresAt };
};

// Register
export const register = async (req, res) => {
  let { name, username, email, password, confirmPassword } = req.body;
  const profileImage = req.file ? req.file.location : "";
  if (!username || !email || !password)
    return res.status(400).json({ message: "Missing required fields" });
  if (String(password).length < 8)
    return res.status(400).json({ message: "Password must be at least 8 characters" });
  if (password !== confirmPassword)
    return res.status(400).json({ message: "Passwords do not match" });

  username = String(username).trim().toLowerCase();
  email = String(email).trim().toLowerCase();

  try {
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      const field = existing.username === username ? "Username" : "Email";
      return res.status(409).json({ message: `${field} already exists` });
    }

    const hashedPassword = await bcrypt.hash(password, 11);
    const newUser = new User({ name, username, email, password: hashedPassword, profileImage });
    await newUser.save();

    // Email verification
    const { tokenRaw, tokenHash, expiresAt } = createEmailVerifyToken();
    newUser.emailVerifyTokenHash = tokenHash;
    newUser.emailVerifyExpiresAt = expiresAt;
    await newUser.save();

    const verifyLink = `${APP_URL}/verify-email?token=${tokenRaw}`;
    await sendEmail({
      to: newUser.email,
      subject: "Verify your VKart email",
      html: emailTemplate({
        title: "Verify your email",
        body: "Thanks for signing up. Please verify your email to secure your account.",
        ctaLabel: "Verify Email",
        ctaUrl: verifyLink,
      }),
    });

    // Notify Admins
    createNotification(
      "user",
      "New User Registered",
      `User ${username} (${email}) has joined the platform.`,
      "/admin/users"
    );

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    if (error?.code === 11000) {
      const key = Object.keys(error.keyPattern || {})[0] || "Account";
      return res.status(409).json({ message: `${key} already exists` });
    }
    if (!res.headersSent) res.status(500).json({ message: "Internal server error" });
  }
};

// Verify Email
export const verifyEmail = async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ message: "Missing token" });

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      emailVerifyTokenHash: tokenHash,
      emailVerifyExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    user.emailVerified = true;
    user.emailVerifyTokenHash = undefined;
    user.emailVerifyExpiresAt = undefined;
    await user.save();

    return res.json({ message: "Email verified successfully" });
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Resend verification (logged-in user)
export const resendVerifyEmail = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.emailVerified) return res.json({ message: "Email already verified" });

    const { tokenRaw, tokenHash, expiresAt } = createEmailVerifyToken();
    user.emailVerifyTokenHash = tokenHash;
    user.emailVerifyExpiresAt = expiresAt;
    await user.save();

    const verifyLink = `${APP_URL}/verify-email?token=${tokenRaw}`;
    await sendEmail({
      to: user.email,
      subject: "Verify your VKart email",
      html: emailTemplate({
        title: "Verify your email",
        body: "Please verify your email to enable all features.",
        ctaLabel: "Verify Email",
        ctaUrl: verifyLink,
      }),
    });

    return res.json({ message: "Verification email sent" });
  } catch (err) {
    console.error("Resend verify error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

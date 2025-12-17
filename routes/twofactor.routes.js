// routes/twofactor.routes.js
import express from "express";
import speakeasy from "speakeasy";
import qrcode from "qrcode";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { buildCookieOpts } from "../utils/cookies.js";

const router = express.Router();

// must be exactly 32 bytes
const ENC_KEY = Buffer.from(process.env.AES_KEY || "", "utf8");
const HAS_VALID_KEY = ENC_KEY.length === 32;
if (!HAS_VALID_KEY) {
  console.warn("⚠ AES_KEY must be 32 bytes");
}

function encrypt(text) {
  if (!HAS_VALID_KEY) throw new Error("AES key invalid");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(encryptedText) {
  if (!HAS_VALID_KEY) throw new Error("AES key invalid");
  if (!encryptedText || typeof encryptedText !== "string") return null;
  const parts = encryptedText.split(":");
  if (parts.length !== 2) return null;
  const [ivHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENC_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

async function requireAuth(req, res, next) {
  try {
    // Check cookie first, then Authorization header as fallback
    let token = req.cookies?.jwt_token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) return res.status(401).json({ message: "Login required" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ message: "Invalid token" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Unauthorized" });
  }
}
// 1) generate secret + QR
router.post("/2fa/setup", requireAuth, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `VKart (${req.user.email})`,
      length: 20,
    });

    const qr = await qrcode.toDataURL(secret.otpauth_url);

    // send base32 back so UI can send it to /2fa/enable
    res.json({
      qr,
      manualEntryKey: secret.base32,
      secret: secret.base32,
    });
  } catch (err) {
    console.error("2FA setup error:", err);
    res.status(500).json({ message: "Error generating setup" });
  }
});

// 2) enable 2FA (user sends code + secret)
router.post("/2fa/enable", requireAuth, async (req, res) => {
  try {
    const { token, secret } = req.body;
    if (!token || !secret) return res.status(400).json({ message: "Missing data" });

    const ok = speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token,
      window: 1,
    });

    if (!ok) return res.status(400).json({ message: "Invalid code" });

    if (!HAS_VALID_KEY)
      return res.status(500).json({ message: "2FA key not configured on server" });

    req.user.twoFactorSecretEnc = encrypt(secret);
    req.user.twoFactorEnabled = true;
    await req.user.save();

    res.json({ message: "2FA enabled" });
  } catch (err) {
    console.error("2FA enable error:", err);
    res.status(500).json({ message: "Error enabling 2FA" });
  }
});

// 3) disable
router.post("/2fa/disable", requireAuth, async (req, res) => {
  try {
    req.user.twoFactorEnabled = false;
    req.user.twoFactorSecretEnc = undefined;
    await req.user.save();
    res.json({ message: "2FA disabled" });
  } catch (err) {
    console.error("2FA disable error:", err);
    res.status(500).json({ message: "Error disabling 2FA" });
  }
});

// 4) verify (when login said require2FA)
router.post("/2fa/login-verify", async (req, res) => {
  try {
    const { userId, token } = req.body;
    if (!userId || !token)
      return res.status(400).json({ message: "Missing parameters" });

    // select the encrypted field explicitly
    const user = await User.findById(userId).select("+twoFactorSecretEnc");
    if (!user || !user.twoFactorEnabled)
      return res.status(400).json({ message: "2FA not enabled" });

    if (!user.twoFactorSecretEnc)
      return res.status(400).json({ message: "No 2FA secret found" });

    if (!HAS_VALID_KEY)
      return res.status(500).json({ message: "2FA key not configured on server" });

    const base32Secret = decrypt(user.twoFactorSecretEnc);
    if (!base32Secret)
      return res.status(500).json({ message: "Could not read 2FA secret" });

    const ok = speakeasy.totp.verify({
      secret: base32Secret,
      encoding: "base32",
      token,
      window: 1,
    });

    if (!ok) return res.status(400).json({ message: "Invalid verification code" });

    const jwtToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    res.cookie("jwt_token", jwtToken, buildCookieOpts(req, true));
    res.json({ token: jwtToken });
  } catch (err) {
    console.error("2FA verify error:", err);
    res.status(500).json({ message: "Error verifying 2FA" });
  }
});

// 5) suppress popup
router.post("/2fa/suppress", requireAuth, async (req, res) => {
  try {
    req.user.suppress2faPrompt = true;
    await req.user.save();
    res.json({ message: "2FA prompt suppressed" });
  } catch (err) {
    console.error("2FA suppress error:", err);
    res.status(500).json({ message: "Error suppressing prompt" });
  }
});

export default router;

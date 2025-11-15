import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Resend } from 'resend';
import { OAuth2Client } from 'google-auth-library';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import speakeasy from 'speakeasy';

import User from '../models/User.js';
import TokenBlacklist from "../models/TokenBlacklist.js"; 
import { buildCookieOpts } from '../utils/cookies.js';
import { s3 } from '../utils/s3.js';
import {
  authLimiter,
  registerLimiter,
  forgotLimiter,
  resetLimiter,
  googleLimiter,
} from '../middleware/security.js';

const router = express.Router();

/* -------------------- file upload -------------------- */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET || 'vkart-assets-mumbai',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) =>
      cb(null, `profile-images/${Date.now()}${path.extname(file.originalname)}`),
    serverSideEncryption: 'AES256',
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext))
      return cb(new Error('Only images allowed (.png/.jpg/.jpeg/.webp)'));
    cb(null, true);
  },
});

const uploadErrorHandler = (err, req, res, next) => {
  if (err && (err.name === 'MulterError' || err.message?.startsWith('Only images')))
    return res.status(400).json({ message: err.message });
  next(err);
};

/* -------------------- shared 2FA helpers -------------------- */
const ENC_KEY = Buffer.from(process.env.AES_KEY || '', 'utf8'); // must be 32 bytes
const HAS_VALID_KEY = ENC_KEY.length === 32;
if (!HAS_VALID_KEY) {
  console.warn('⚠ AES_KEY must be 32 bytes for 2FA');
}

function decrypt2FA(enc) {
  if (!HAS_VALID_KEY) throw new Error('2FA key not configured');
  if (!enc || typeof enc !== 'string') return null;
  const parts = enc.split(':');
  if (parts.length !== 2) return null;
  const [ivHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8'); // this is the base32 secret
}

/* -------------------- constants -------------------- */
const resend = new Resend(process.env.RESEND_API_KEY || 'dummy_key');
const FROM_EMAIL = process.env.FROM_EMAIL || 'VKart <onboarding@resend.dev>';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/* -------------------- register -------------------- */
router.post(
  '/register',
  registerLimiter,
  upload.single('profileImage'),
  uploadErrorHandler,
  async (req, res) => {
    let { name, username, email, password, confirmPassword } = req.body;
    const profileImage = req.file ? req.file.location : '';
    if (!username || !email || !password)
      return res.status(400).json({ message: 'Missing required fields' });
    if (password !== confirmPassword)
      return res.status(400).json({ message: 'Passwords do not match' });

    username = String(username).trim().toLowerCase();
    email = String(email).trim().toLowerCase();

    try {
      const existing = await User.findOne({ $or: [{ username }, { email }] });
      if (existing) {
        const field = existing.username === username ? 'Username' : 'Email';
        return res.status(409).json({ message: `${field} already exists` });
      }

      const hashedPassword = await bcrypt.hash(password, 11);
      const newUser = new User({ name, username, email, password: hashedPassword, profileImage });
      await newUser.save();
      res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
      if (error?.code === 11000) {
        const key = Object.keys(error.keyPattern || {})[0] || 'Account';
        return res.status(409).json({ message: `${key} already exists` });
      }
      if (!res.headersSent)
        res.status(500).json({ message: 'Internal server error' });
    }
  }
);

/* -------------------- login (with 2FA) -------------------- */
router.post('/login', authLimiter, async (req, res) => {
  const { username, password, remember, token2fa } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: 'Invalid payload' });

  const id = String(username).trim().toLowerCase();
  // pick password AND 2FA secret
  const user = await User.findOne({ $or: [{ username: id }, { email: id }] })
    .select('+password +twoFactorSecretEnc');

  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ message: 'Invalid credentials' });

  // if user enabled 2FA
  if (user.twoFactorEnabled) {
    // if no code yet -> ask frontend to show code box
    if (!token2fa) {
      return res.json({
        require2FA: true,
        userId: user._id, // frontend can use this for /api/2fa/login-verify too
      });
    }

    // user sent code -> verify
    if (!user.twoFactorSecretEnc) {
      return res
        .status(500)
        .json({ message: '2FA secret missing. Please disable and enable 2FA again.' });
    }

    if (!HAS_VALID_KEY) {
      return res.status(500).json({ message: '2FA key not configured on server' });
    }

    let base32Secret = null;
    try {
      base32Secret = decrypt2FA(user.twoFactorSecretEnc);
    } catch (err) {
      console.error('2FA decrypt error in login:', err);
      return res.status(500).json({ message: '2FA verification failed' });
    }

    if (!base32Secret) {
      return res.status(500).json({ message: '2FA secret invalid' });
    }

    const ok = speakeasy.totp.verify({
      secret: base32Secret,
      encoding: 'base32',
      token: token2fa,
      window: 1,
    });

    if (!ok) {
      return res.status(401).json({ message: 'Invalid 2FA code' });
    }
  }

  // final login
  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('jwt_token', token, buildCookieOpts(req, remember));
  res.json({ token });
});

/* -------------------- Google OAuth -------------------- */
router.post('/auth/google', googleLimiter, async (req, res) => {
  try {
    const credential = req.body.credential || req.body.idToken;
    if (!credential)
      return res.status(400).json({ message: 'Missing Google credential' });

    if (!googleClient)
      return res.status(500).json({ message: 'Google client not configured' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email)
      return res.status(400).json({ message: 'Google account missing email' });

    const email = payload.email.toLowerCase();
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: payload.name,
        username: email.split('@')[0],
        email,
        profileImage: payload.picture || '',
        password: await bcrypt.hash(crypto.randomBytes(10).toString('hex'), 11),
      });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });

    res.cookie('jwt_token', token, buildCookieOpts(req, true));
    res.json({ token });
  } catch (err) {
    console.error('Google login error:', err.message);
    res.status(401).json({ message: 'Google sign-in failed' });
  }
});

/* -------------------- forgot password -------------------- */
router.post('/forgot', forgotLimiter, async (req, res) => {
  try {
    const raw = (req.body.emailOrUsername || '').toString().trim().toLowerCase();
    if (!raw) return res.json({ message: 'If an account exists, a reset link was sent.' });

    const user = await User.findOne({ $or: [{ email: raw }, { username: raw }] });
    if (user?.email) {
      const tokenRaw = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(tokenRaw).digest('hex');
      user.resetPasswordTokenHash = tokenHash;
      user.resetPasswordExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();

      const appUrl = (process.env.APP_URL || 'https://vkartshop.netlify.app').replace(/\/+$/, '');
      const link = `${appUrl}/reset-password?token=${tokenRaw}`;

      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: user.email,
          subject: 'VKart password reset',
          html: `<p>Click to reset (expires in 30m)</p>
                 <p><a href="${link}">Reset Password</a></p>
                 <p>${link}</p>`,
        });
      } catch {
        console.warn('Email send skipped in test env');
      }
    }

    res.json({ message: 'If an account exists, a reset link was sent.' });
  } catch {
    res.json({ message: 'If an account exists, a reset link was sent.' });
  }
});

/* -------------------- reset password -------------------- */
router.post('/reset', resetLimiter, async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token || !password || !confirmPassword)
      return res.status(400).json({ message: 'Invalid payload' });
    if (password !== confirmPassword)
      return res.status(400).json({ message: 'Passwords do not match' });
    if (password.length < 8)
      return res.status(400).json({ message: 'Use at least 8 characters' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() },
    }).select('+password');

    if (!user)
      return res.status(400).json({ message: 'Invalid or expired token' });

    user.password = await bcrypt.hash(password, 11);
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpiresAt = undefined;
    await user.save();

    res.clearCookie('jwt_token', { path: '/', httpOnly: true, sameSite: 'Lax' });
    res.json({ message: 'Password reset successful' });
  } catch {
    res.status(500).json({ message: 'Internal server error' });
  }
});

/* -------------------- Admin Login -------------------- */
router.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "Invalid payload" });

  const id = String(username).trim().toLowerCase();
  const user = await User.findOne({ $or: [{ username: id }, { email: id }] }).select("+password");

  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ message: "Invalid credentials" });

  //  Only allow these two emails
  const adminEmails = ["balavardhan12178@gmail.com", "balavardhanpula@gmail.com"];
  if (!adminEmails.includes(user.email)) {
    return res.status(403).json({ message: "Access denied: Not an admin" });
  }

  //  Issue admin JWT
  const token = jwt.sign({ userId: user._id, role: "admin" }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });

  res.cookie("jwt_token", token, buildCookieOpts(req, true));
  res.json({ token, role: "admin" });
});

/* -------------------- Admin Google OAuth -------------------- */
router.post("/admin/google", async (req, res) => {
  try {
    const credential = req.body.credential || req.body.idToken;
    if (!credential) return res.status(400).json({ message: "Missing Google credential" });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();

    const adminEmails = ["balavardhan12178@gmail.com", "balavardhanpula@gmail.com"];
    if (!email || !adminEmails.includes(email)) {
      return res.status(403).json({ message: "Access denied: Not an admin" });
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name: payload.name,
        username: email.split("@")[0],
        email,
        profileImage: payload.picture || "",
        password: await bcrypt.hash(crypto.randomBytes(10).toString("hex"), 11),
      });
    }

    const token = jwt.sign({ userId: user._id, role: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.cookie("jwt_token", token, buildCookieOpts(req, true));
    res.json({ token, role: "admin" });
  } catch (err) {
    console.error("Admin Google login error:", err.message);
    res.status(401).json({ message: "Google sign-in failed" });
  }
});


/* -------------------- logout -------------------- */
router.post("/logout", async (req, res) => {
  try {
    const token = req.cookies.jwt_token || req.headers.authorization?.split(" ")[1];
    if (token) {
      await TokenBlacklist.create({
        token,
        expiredAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), 
      });
    }

    res.clearCookie("jwt_token", { path: "/", httpOnly: true, sameSite: "Lax" });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


export default router;

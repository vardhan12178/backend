import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Resend } from 'resend';
import { OAuth2Client } from 'google-auth-library';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';

import User from '../models/User.js';
import { buildCookieOpts } from '../utils/cookies.js';
import { s3 } from '../utils/s3.js';
import {
  authLimiter,
  registerLimiter,
  forgotLimiter,
  resetLimiter,
  googleLimiter
} from '../middleware/security.js';

const router = express.Router();

/* -------------------- File Upload (Profile Image) -------------------- */
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

/* -------------------- Constants & Clients -------------------- */
const resend = new Resend(process.env.RESEND_API_KEY || 'dummy_key');
const FROM_EMAIL = process.env.FROM_EMAIL || 'VKart <onboarding@resend.dev>';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/* -------------------- Register -------------------- */
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

/* -------------------- Login -------------------- */
router.post('/login', authLimiter, async (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: 'Invalid payload' });

  const id = String(username).trim().toLowerCase();
  const user = await User.findOne({ $or: [{ username: id }, { email: id }] }).select('+password');
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ message: 'Invalid credentials' });

  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('jwt_token', token, buildCookieOpts(req, remember));
  res.json({ token });
});

/* -------------------- Forgot Password -------------------- */
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

/* -------------------- Reset Password -------------------- */
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

/* -------------------- Logout -------------------- */
router.post('/logout', (req, res) => {
  res.clearCookie('jwt_token', { path: '/', httpOnly: true, sameSite: 'Lax' });
  res.json({ message: 'Logged out' });
});

export default router;

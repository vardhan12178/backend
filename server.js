require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { S3Client } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');
const path = require('path');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Resend } = require('resend');
const { OAuth2Client } = require('google-auth-library');

const User = require('./models/User');
const Order = require('./models/Order');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
  // Optional, if we load images/scripts from other origins:
  // crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms`);
  });
  next();
});

app.use(cors({
  origin: ['http://localhost:3000', 'https://vkartshop.netlify.app'],
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','X-CSRF-Token'],
}));
app.options('*', cors());

app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true }));
app.use('/api/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true }));
app.use('/auth/forgot', rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true }));
app.use('/auth/reset', rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true }));
app.use('/auth/google', rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true }));

mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 20000,
}).then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('Failed to connect to MongoDB Atlas', err));

const s3 = new S3Client({
  region: process.env.S3_REGION || 'ap-south-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
});

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET || 'vkart-assets-mumbai',
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) => cb(null, `profile-images/${Date.now()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error('Only images allowed (.png/.jpg/.jpeg/.webp)'));
    cb(null, true);
  }
});

function uploadErrorHandler(err, req, res, next) {
  if (err && (err.name === 'MulterError' || err.message?.startsWith('Only images allowed'))) {
    return res.status(400).json({ message: err.message });
  }
  next(err);
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not set');
  process.exit(1);
}

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'VKart <onboarding@resend.dev>';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.error('FATAL: GOOGLE_CLIENT_ID not set');
  process.exit(1);
}
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const authenticateJWT = (req, res, next) => {
  const bearer = req.headers.authorization;
  const token =
    req.cookies?.jwt_token ||
    (bearer && bearer.startsWith('Bearer ') ? bearer.split(' ')[1] : null);

  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Forbidden' });
    req.user = user;
    next();
  });
};


app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/ready', async (req, res) => {
  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    res.status(200).send('ready');
  } catch {
    res.status(500).send('not-ready');
  }
});

app.post('/api/register', upload.single('profileImage'), uploadErrorHandler, async (req, res) => {
  let { name, username, email, password, confirmPassword } = req.body;
  const profileImage = req.file ? req.file.location : '';
  if (!username || !email || !password) return res.status(400).json({ message: 'Missing required fields' });
  if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' });
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
    console.error('Register error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Invalid payload' });
  const id = String(username).trim().toLowerCase();
  const query = { $or: [{ username: id }, { email: id }] };
  try {
    const user = await User.findOne(query).select('+password');
    if (!user || typeof user.password !== 'string') return res.status(401).json({ message: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
      path: '/'
    };
    if (remember) cookieOpts.maxAge = 30 * 24 * 60 * 60 * 1000;
    res.cookie('jwt_token', token, cookieOpts);
    res.json({ token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

console.log('Registering route: POST /auth/google');
app.post('/auth/google/ping', (req, res) => res.json({ ok: true }));

app.post('/auth/google', async (req, res) => {
  try {
    const { idToken, remember } = req.body;
    if (!idToken) return res.status(400).json({ message: 'Missing idToken' });

    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload) return res.status(400).json({ message: 'Invalid token' });

    const { email, email_verified, name, picture } = payload;
    if (!email || !email_verified) return res.status(400).json({ message: 'Email not verified by Google' });

    const emailLc = email.toLowerCase().trim();
    let user = await User.findOne({ email: emailLc }).select('+password');

    if (!user) {
      let base = emailLc.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'user';
      let candidate = base;
      let n = 1;
      while (await User.exists({ username: candidate })) candidate = `${base}${n++}`;
      const randomPwd = crypto.randomBytes(32).toString('hex');
      const hashed = await bcrypt.hash(randomPwd, 11);
      user = new User({
        name: name || candidate,
        username: candidate,
        email: emailLc,
        password: hashed,
        profileImage: picture || ''
      });
      await user.save();
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
      path: '/'
    };
    if (remember) cookieOpts.maxAge = 30 * 24 * 60 * 60 * 1000;

    res.cookie('jwt_token', token, cookieOpts);
    res.json({ token });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(400).json({ message: 'Google sign-in failed' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('jwt_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    path: '/'
  });
  res.json({ message: 'Logged out' });
});

app.post('/auth/forgot', async (req, res) => {
  try {
    const raw = (req.body.emailOrUsername || '').toString().trim().toLowerCase();
    if (!raw) return res.json({ message: 'If an account exists, a reset link was sent.' });
    const user = await User.findOne({ $or: [{ email: raw }, { username: raw }] });
    if (user && user.email) {
      const tokenRaw = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(tokenRaw).digest('hex');
      user.resetPasswordTokenHash = tokenHash;
      user.resetPasswordExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();
      const appUrl = process.env.APP_URL || 'https://vkartshop.netlify.app';
      const link = `${appUrl.replace(/\/+$/,'')}/reset-password?token=${tokenRaw}`;
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: user.email,
          subject: 'VKart password reset',
          html: `<p>Click the button below to reset your password. This link expires in 30 minutes.</p><p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#ea580c;color:#fff;text-decoration:none;border-radius:8px">Reset Password</a></p><p>If the button doesn’t work, copy this link:<br>${link}</p>`
        });
      } catch (e) {
        console.error('Email send error:', e);
      }
    }
    res.json({ message: 'If an account exists, a reset link was sent.' });
  } catch (e) {
    console.error('Forgot error:', e);
    res.json({ message: 'If an account exists, a reset link was sent.' });
  }
});

app.post('/auth/reset', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token || !password || !confirmPassword) return res.status(400).json({ message: 'Invalid payload' });
    if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' });
    if (password.length < 8) return res.status(400).json({ message: 'Use at least 8 characters' });
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const now = new Date();
    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: now }
    }).select('+password');
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });
    user.password = await bcrypt.hash(password, 11);
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpiresAt = undefined;
    await user.save();
    res.clearCookie('jwt_token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
      path: '/'
    });
    res.json({ message: 'Password reset successful' });
  } catch (e) {
    console.error('Reset error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/profile', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/profile/upload', authenticateJWT, upload.single('profileImage'), uploadErrorHandler, async (req, res) => {
  try {
    if (!req.file?.location) return res.status(400).json({ message: 'No image uploaded' });
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.profileImage = req.file.location;
    await user.save();
    res.json(user);
  } catch (error) {
    console.error('Profile upload error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

const STAGES = ['PLACED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

const validateOrder = [
  body('products').isArray({ min: 1 }).withMessage('Products must be a non-empty array'),
  body('products.*.productId').optional({ nullable: true }).isMongoId().withMessage('productId must be a valid MongoDB ObjectId'),
  body('products.*.externalId').optional({ nullable: true }).isString().withMessage('externalId must be a string'),
  body('products').custom((arr) => Array.isArray(arr) && arr.every(p => p.productId || p.externalId)).withMessage('Each product must include productId or externalId'),
  body('products.*.name').isString().withMessage('Each product must have a name'),
  body('products.*.image').optional({ nullable: true }).isString().withMessage('Each product image must be a string'),
  body('products.*.quantity').isInt({ gt: 0 }).withMessage('Each product quantity must be a positive integer'),
  body('products.*.price').isFloat({ gt: 0 }).withMessage('Each product price must be a positive number'),

  body('tax').optional().isFloat({ min: 0 }).withMessage('Tax must be a non-negative number'),
  body('shipping').optional().isFloat({ min: 0 }).withMessage('Shipping must be a non-negative number'),
  body('totalPrice').optional().isFloat({ gt: 0 }).withMessage('Total price must be a positive number'),

  body('stage')
    .optional()
    .customSanitizer(v => typeof v === 'string' ? v.toUpperCase() : v)
    .isIn(STAGES)
    .withMessage('Invalid order stage'),

  body('shippingAddress').isString().withMessage('Shipping address must be a string')
];


app.post('/api/orders', authenticateJWT, validateOrder, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { products, shippingAddress } = req.body;
  const stage = typeof req.body.stage === 'string' ? req.body.stage : undefined;
  const tax = Number(req.body.tax) || 0;
  const shipping = Number(req.body.shipping) || 0;

  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const newOrder = new Order({
      userId: user._id,
      products,
      tax,
      shipping,
      stage,
      shippingAddress
    
    });

    await newOrder.save();
    await User.updateOne({ _id: user._id }, { $push: { orders: newOrder._id } });

    res.status(201).json(newOrder);
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/profile/orders', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!userId) return res.status(400).json({ message: 'User ID missing' });
    const user = await User.findById(userId).populate('orders').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user.orders);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

app.get('/api/profile/orders/paged', authenticateJWT, async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip  = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Order.find({ userId: req.user.userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments({ userId: req.user.userId })
    ]);
    res.json({ page, limit, total, items });
  } catch (error) {
    console.error('Fetch paged orders error:', error);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

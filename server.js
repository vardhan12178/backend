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

const User = require('./models/User');
const Order = require('./models/Order');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50kb' }));
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
}));

app.use('/api/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
}));

mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 20000,
}).then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('Failed to connect to MongoDB Atlas', err));

const s3 = new S3Client({
  region: process.env.S3_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET || 'vkart-assets-mumbai',
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) =>
      cb(null, `profile-images/${Date.now()}${path.extname(file.originalname)}`)
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

const authenticateJWT = (req, res, next) => {
  const token = req.cookies.jwt_token;
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
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Invalid payload' });
  const id = String(username).trim().toLowerCase();
  const query = { $or: [{ username: id }, { email: id }] };
  try {
    const user = await User.findOne(query).select('+password');
    if (!user || typeof user.password !== 'string') return res.status(401).json({ message: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('jwt_token', token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    });
    res.json({ token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('jwt_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
  });
  res.json({ message: 'Logged out' });
});

app.get('/api/profile', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/profile/upload', authenticateJWT, upload.single('profileImage'), uploadErrorHandler, async (req, res) => {
  try {
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
  body('totalPrice').isFloat({ gt: 0 }).withMessage('Total price must be a positive number'),
  body('stage').optional().isIn(STAGES).withMessage('Invalid order stage'),
  body('shippingAddress').isString().withMessage('Shipping address must be a string')
];

app.post('/api/orders', authenticateJWT, validateOrder, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { products, totalPrice, shippingAddress, stage } = req.body;
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const newOrder = new Order({ userId: user._id, products, totalPrice, stage, shippingAddress });
    await newOrder.save();
    user.orders.push(newOrder._id);
    await user.save();
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
    const user = await User.findById(userId).populate('orders');
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
      Order.find({ userId: req.user.userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments({ userId: req.user.userId })
    ]);
    res.json({ page, limit, total, items });
  } catch (error) {
    console.error('Fetch paged orders error:', error);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

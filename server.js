// Import required packages and modules
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

// Import models
const User = require('./models/User');
const Order = require('./models/Order');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 5000;

// Configure AWS S3
const s3 = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

// Configure multer for file uploads
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: 'vkart-container',
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      cb(null, `profile-images/${Date.now()}${path.extname(file.originalname)}`);
    }
  })
});

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: ['http://localhost:3000', 'https://vkartshop.netlify.app'],
  credentials: true,
}));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('Failed to connect to MongoDB Atlas', err));

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET;

// Authentication middleware
const authenticateJWT = (req, res, next) => {
  const token = req.cookies.jwt_token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Forbidden' });
    req.user = user;
    next();
  });
};

// User registration
app.post('/api/register', upload.single('profileImage'), async (req, res) => {
  const { name, username, email, password, confirmPassword } = req.body;
  const profileImage = req.file ? req.file.location : '';

  if (password !== confirmPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, username, email, password: hashedPassword, profileImage });
    await newUser.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

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

// Get user profile
app.get('/api/profile', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Upload profile image
app.post('/api/profile/upload', authenticateJWT, upload.single('profileImage'), async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.profileImage = req.file.location;
    await user.save();

    res.json(user);
  } catch (error) {
    console.error('Profile image upload error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Order validation middleware
const validateOrder = [
  body('products').isArray().withMessage('Products must be an array'),
  body('products.*.productId').isMongoId().withMessage('Each productId must be a valid MongoDB ObjectId'),
  body('products.*.name').isString().withMessage('Each product must have a name'),
  body('products.*.image').isString().withMessage('Each product must have an image URL'),
  body('products.*.quantity').isInt({ gt: 0 }).withMessage('Each product quantity must be a positive integer'),
  body('products.*.price').isFloat({ gt: 0 }).withMessage('Each product price must be a positive number'),
  body('totalPrice').isFloat({ gt: 0 }).withMessage('Total price must be a positive number'),
  body('stage').isString().withMessage('Order stage must be a string'),
  body('shippingAddress').isString().withMessage('Shipping address must be a string')
];

// Create order
app.post('/api/orders', authenticateJWT, validateOrder, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { products, totalPrice, shippingAddress, stage } = req.body;

  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const newOrder = new Order({
      userId: user._id,
      products,
      totalPrice,
      stage,
      shippingAddress
    });

    await newOrder.save();

    user.orders.push(newOrder._id);
    await user.save();

    res.status(201).json(newOrder);
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get user orders
app.get('/api/profile/orders', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!userId) return res.status(400).json({ message: 'User ID missing' });

    const user = await User.findById(userId).populate('orders');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user.orders);
  } catch (error) {
    console.error('Failed to fetch orders:', error);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

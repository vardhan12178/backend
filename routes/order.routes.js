import express from 'express';
import { body, validationResult } from 'express-validator';
import Order from '../models/Order.js';
import User from '../models/User.js';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();
const STAGES = ['PLACED','CONFIRMED','SHIPPED','DELIVERED','CANCELLED'];

const validateOrder = [
  body('products').isArray({ min: 1 }),
  body('products.*.productId').optional({ nullable: true }).isMongoId(),
  body('products.*.externalId').optional({ nullable: true }).isString(),
  body('products').custom((arr) => Array.isArray(arr) && arr.every(p => p.productId || p.externalId)),
  body('products.*.name').isString(),
  body('products.*.image').optional({ nullable: true }).isString(),
  body('products.*.quantity').isInt({ gt: 0 }),
  body('products.*.price').isFloat({ gt: 0 }),
  body('tax').optional().isFloat({ min: 0 }),
  body('shipping').optional().isFloat({ min: 0 }),
  body('totalPrice').optional().isFloat({ gt: 0 }),
  body('stage').optional().customSanitizer(v => typeof v === 'string' ? v.toUpperCase() : v).isIn(STAGES),
  body('shippingAddress').isString()
];

router.post('/orders', authenticateJWT, validateOrder, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { products, shippingAddress } = req.body;
  const stage = typeof req.body.stage === 'string' ? req.body.stage : undefined;
  const tax = Number(req.body.tax) || 0;
  const shipping = Number(req.body.shipping) || 0;

  const user = await User.findById(req.user.userId).lean();
  if (!user) return res.status(404).json({ message: 'User not found' });

  const newOrder = new Order({ userId: user._id, products, tax, shipping, stage, shippingAddress });
  await newOrder.save();
  await User.updateOne({ _id: user._id }, { $push: { orders: newOrder._id } });

  res.status(201).json(newOrder);
});

router.get('/profile/orders', authenticateJWT, async (req, res) => {
  const user = await User.findById(req.user.userId).populate('orders').lean();
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user.orders);
});

router.get('/profile/orders/paged', authenticateJWT, async (req, res) => {
  const page  = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const skip  = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Order.find({ userId: req.user.userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments({ userId: req.user.userId })
  ]);
  res.json({ page, limit, total, items });
});

export default router;

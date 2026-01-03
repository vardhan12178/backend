import express from 'express';
import { authenticateJWT, requireAdmin } from '../middleware/auth.js';
import { getNotifications, markAsRead } from '../controllers/admin.notifications.controller.js';

const router = express.Router();

// Protected Routes
router.use(authenticateJWT, requireAdmin);

router.get('/', getNotifications);
router.put('/read', markAsRead);

export default router;

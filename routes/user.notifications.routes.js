import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { getUserNotifications, markUserNotificationsRead } from '../controllers/user.notifications.controller.js';

const router = express.Router();

// Protected Routes - requires authenticated user
router.use(authenticateJWT);

router.get('/', getUserNotifications);
router.put('/read', markUserNotificationsRead);

export default router;

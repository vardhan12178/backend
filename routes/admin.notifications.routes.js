import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getNotifications, markAsRead } from '../controllers/admin.notifications.controller.js';

const router = express.Router();

// Protected Routes
router.use(authenticateJWT);

router.get('/', requirePermission('notifications', 'read'), getNotifications);
router.put('/read', requirePermission('notifications', 'write'), markAsRead);

export default router;

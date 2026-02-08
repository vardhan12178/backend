import express from 'express';
import { authenticateJWT, requireAdmin } from '../middleware/auth.js';
import { profileUpload } from '../utils/upload.js';
import {
    getSettings,
    updateStoreSettings,
    updateAdminProfile,
    getAnnouncements,
    updateAnnouncements
} from '../controllers/admin.settings.controller.js';

const router = express.Router();

// Public: active announcements (no auth)
router.get('/announcements/public', getAnnouncements);

// All remaining routes require Admin Auth
router.use(authenticateJWT, requireAdmin);

// GET /api/admin/settings
router.get('/', getSettings);

// PUT /api/admin/settings/store (supports logo upload)
router.put('/store', profileUpload.single('storeLogo'), updateStoreSettings);

// PUT /api/admin/settings/profile (supports avatar upload)
router.put('/profile', profileUpload.single('profileImage'), updateAdminProfile);

// Announcements
router.get('/announcements', getAnnouncements);
router.put('/announcements', updateAnnouncements);

export default router;

import express from 'express';
import { authenticateJWT, requireAdmin } from '../middleware/auth.js';
import { profileUpload } from '../utils/upload.js';
import {
    getSettings,
    updateStoreSettings,
    updateAdminProfile
} from '../controllers/admin.settings.controller.js';

const router = express.Router();

// All routes require Admin Auth
router.use(authenticateJWT, requireAdmin);

// GET /api/admin/settings
router.get('/', getSettings);

// PUT /api/admin/settings/store (supports logo upload)
router.put('/store', profileUpload.single('storeLogo'), updateStoreSettings);

// PUT /api/admin/settings/profile (supports avatar upload)
router.put('/profile', profileUpload.single('profileImage'), updateAdminProfile);

export default router;

import express from 'express';
import { authenticateJWT, requireAdmin } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
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

// All remaining routes require admin auth
router.use(authenticateJWT);

// GET /api/admin/settings
router.get('/', requirePermission('settings', 'read'), getSettings);

// PUT /api/admin/settings/store
router.put('/store', requirePermission('settings', 'write'), updateStoreSettings);

// PUT /api/admin/settings/profile (supports avatar upload)
// Note: this updates the acting admin's own profile — allowed for any admin
// account regardless of module permissions (not module-gated), but still
// requires a valid admin JWT.
router.put('/profile', requireAdmin, profileUpload.single('profileImage'), updateAdminProfile);

// Announcements
router.get('/announcements', requirePermission('settings', 'read'), getAnnouncements);
router.put('/announcements', requirePermission('settings', 'write'), updateAnnouncements);

export default router;

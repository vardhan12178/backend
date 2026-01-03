import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { profileUpload, uploadErrorHandler } from '../utils/upload.js';
import * as profileController from '../controllers/profile.controller.js';

const router = express.Router();

/* GET /api/profile - Cached */
router.get('/profile', authenticateJWT, profileController.getProfile);

/* POST /api/profile/upload - Invalidates Cache */
router.post(
  '/profile/upload',
  authenticateJWT,
  profileUpload.single('profileImage'),
  uploadErrorHandler,
  profileController.uploadProfileImage
);

export default router;

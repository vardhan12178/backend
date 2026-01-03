import express from 'express';
import { profileUpload, uploadErrorHandler } from '../utils/upload.js';
import {
  authLimiter,
  registerLimiter,
  forgotLimiter,
  resetLimiter,
  googleLimiter,
} from '../middleware/security.js';
import * as authController from '../controllers/auth.controller.js';

const router = express.Router();

/* -------------------- User Auth -------------------- */
router.post(
  '/register',
  registerLimiter,
  profileUpload.single('profileImage'),
  uploadErrorHandler,
  authController.register
);

router.post('/login', authLimiter, authController.login);
router.post('/auth/google', googleLimiter, authController.googleAuth);
router.post('/forgot', forgotLimiter, authController.forgotPassword);
router.post('/reset', resetLimiter, authController.resetPassword);
router.post('/logout', authController.logout);

/* -------------------- Admin Auth -------------------- */
router.post("/admin/login", authController.adminLogin);
router.post("/admin/google", authController.adminGoogleAuth);
router.get("/admin/verify", authController.verifyAdmin);
router.post("/admin/logout", authController.logout);

export default router;

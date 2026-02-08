import express from 'express';
import { body } from 'express-validator';
import validate from '../middleware/validate.js';
import { authenticateJWT } from '../middleware/auth.js';
import { profileUpload, uploadErrorHandler } from '../utils/upload.js';
import * as profileController from '../controllers/profile.controller.js';

const router = express.Router();

/* GET /api/profile - Cached */
router.get('/profile', authenticateJWT, profileController.getProfile);

/* PUT /api/profile/name - Update display name */
router.put('/profile/name', authenticateJWT, [
  body('name').trim().notEmpty().withMessage('Name is required'),
], validate, profileController.updateName);

/* POST /api/profile/upload - Invalidates Cache */
router.post(
  '/profile/upload',
  authenticateJWT,
  profileUpload.single('profileImage'),
  uploadErrorHandler,
  profileController.uploadProfileImage
);

/* CART */
router.get('/profile/cart', authenticateJWT, profileController.getCart);
router.put('/profile/cart', authenticateJWT, profileController.updateCart);

/* WISHLIST */
router.get('/profile/wishlist', authenticateJWT, profileController.getWishlist);
router.put('/profile/wishlist', authenticateJWT, profileController.updateWishlist);

/* ADDRESSES */
router.get('/profile/addresses', authenticateJWT, profileController.listAddresses);
router.post('/profile/addresses', authenticateJWT, [
  body('name').isString().trim().notEmpty().isLength({ max: 100 }),
  body('phone').isString().trim().notEmpty().isLength({ min: 10, max: 15 }),
  body('line1').isString().trim().notEmpty().isLength({ max: 200 }),
  body('city').isString().trim().notEmpty().isLength({ max: 100 }),
  body('state').isString().trim().notEmpty().isLength({ max: 100 }),
  body('pincode').isString().trim().notEmpty().isLength({ min: 4, max: 10 }),
], validate, profileController.addAddress);
router.put('/profile/addresses/:id', authenticateJWT, [
  body('name').optional().isString().trim().isLength({ max: 100 }),
  body('phone').optional().isString().trim().isLength({ min: 10, max: 15 }),
  body('line1').optional().isString().trim().isLength({ max: 200 }),
  body('city').optional().isString().trim().isLength({ max: 100 }),
  body('state').optional().isString().trim().isLength({ max: 100 }),
  body('pincode').optional().isString().trim().isLength({ min: 4, max: 10 }),
], validate, profileController.updateAddress);
router.delete('/profile/addresses/:id', authenticateJWT, profileController.deleteAddress);

/* PASSWORD CHANGE */
router.put('/profile/password', authenticateJWT, [
  body('currentPassword').isString().notEmpty(),
  body('newPassword').isString().isLength({ min: 8, max: 128 }),
  body('confirmPassword').isString().notEmpty(),
], validate, profileController.changePassword);

export default router;

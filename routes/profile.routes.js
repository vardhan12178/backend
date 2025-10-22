import express from 'express';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import User from '../models/User.js';
import { authenticateJWT } from '../middleware/auth.js';
import { s3 } from '../utils/s3.js';

const router = express.Router();

// ---- S3 Upload Config ----
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET || 'vkart-assets-mumbai',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) => {
      const filename = `profile-images/${Date.now()}${path.extname(file.originalname)}`;
      cb(null, filename);
    },
    serverSideEncryption: 'AES256'
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error('Only images allowed (.png/.jpg/.jpeg/.webp)'));
    cb(null, true);
  }
});

function uploadErrorHandler(err, req, res, next) {
  if (err && (err.name === 'MulterError' || err.message?.startsWith('Only images allowed'))) {
    return res.status(400).json({ message: err.message });
  }
  next(err);
}

// ---- Routes ----

// Fetch profile
router.get('/profile', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('name username email profileImage createdAt').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Upload new profile image
router.post(
  '/profile/upload',
  authenticateJWT,
  upload.single('profileImage'),
  uploadErrorHandler,
  async (req, res) => {
    try {
      if (!req.file?.location) return res.status(400).json({ message: 'No image uploaded' });

      const user = await User.findById(req.user.userId);
      if (!user) return res.status(404).json({ message: 'User not found' });

      user.profileImage = req.file.location;
      await user.save();

      res.json({ message: 'Profile image updated', profileImage: req.file.location });
    } catch (error) {
      console.error('Profile upload error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
);

export default router;

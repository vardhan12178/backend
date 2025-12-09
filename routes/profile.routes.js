import express from 'express';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import User from '../models/User.js';
import { authenticateJWT } from '../middleware/auth.js';
import { s3 } from '../utils/s3.js';
import redis from '../utils/redis.js';

const router = express.Router();

/* S3 upload config */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET || 'vkart-assets-mumbai',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) =>
      cb(null, `profile-images/${Date.now()}${path.extname(file.originalname)}`),
    serverSideEncryption: 'AES256',
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('Only images allowed (.png/.jpg/.jpeg/.webp)'));
    }
    cb(null, true);
  },
});

function uploadErrorHandler(err, req, res, next) {
  if (err && (err.name === 'MulterError' || err.message?.startsWith('Only images'))) {
    return res.status(400).json({ message: err.message });
  }
  next(err);
}

/* GET /api/profile - Cached */
router.get('/profile', authenticateJWT, async (req, res) => {
  const userId = req.user.userId;
  const cacheKey = `profile:${userId}`;

  // 1. Try Redis Cache
  try {
    const cachedProfile = await redis.get(cacheKey);
    if (cachedProfile) {
      return res.json(JSON.parse(cachedProfile));
    }
  } catch (err) {
    console.warn("Redis Get Error:", err.message);
  }

  // 2. Fallback to Database
  try {
    const user = await User.findById(userId)
      .select('name username email profileImage createdAt twoFactorEnabled suppress2faPrompt')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });

    // 3. Save to Redis (Expires in 1 hour)
    try {
      await redis.set(cacheKey, JSON.stringify(user), 'EX', 3600);
    } catch (err) {
      console.warn("Redis Set Error:", err.message);
    }

    return res.json(user);
  } catch (err) {
    console.error('Profile error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/* POST /api/profile/upload - Invalidates Cache */
router.post(
  '/profile/upload',
  authenticateJWT,
  upload.single('profileImage'),
  uploadErrorHandler,
  async (req, res) => {
    try {
      if (!req.file?.location) {
        return res.status(400).json({ message: 'No image uploaded' });
      }

      const user = await User.findById(req.user.userId);
      if (!user) return res.status(404).json({ message: 'User not found' });

      // Update DB
      user.profileImage = req.file.location;
      await user.save();

      // 4. INVALIDATE CACHE (Crucial Step)
      // We delete the old cache so the next GET /profile fetches the new image
      try {
        await redis.del(`profile:${req.user.userId}`);
      } catch (err) {
        console.warn("Redis Delete Error:", err.message);
      }

      return res.json({
        name: user.name,
        username: user.username,
        email: user.email,
        profileImage: user.profileImage,
        createdAt: user.createdAt,
        twoFactorEnabled: user.twoFactorEnabled,
        suppress2faPrompt: user.suppress2faPrompt,
      });
    } catch (err) {
      console.error('Profile upload error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }
);
export default router;

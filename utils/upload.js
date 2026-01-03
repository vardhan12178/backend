// utils/upload.js - Shared S3 upload configuration
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import { s3 } from './s3.js';

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const BUCKET = process.env.S3_BUCKET || 'vkart-assets-mumbai';

/**
 * Create a multer upload middleware for S3
 * @param {string} folder - S3 folder path (e.g., 'profile-images')
 * @param {number} maxSizeMB - Max file size in MB (default: 2)
 * @returns {multer.Multer} Configured multer instance
 */
export function createUpload(folder = 'uploads', maxSizeMB = 2) {
    return multer({
        storage: multerS3({
            s3,
            bucket: BUCKET,
            contentType: multerS3.AUTO_CONTENT_TYPE,
            metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
            key: (req, file, cb) =>
                cb(null, `${folder}/${Date.now()}${path.extname(file.originalname)}`),
            serverSideEncryption: 'AES256',
        }),
        limits: { fileSize: maxSizeMB * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (!ALLOWED_EXT.has(ext)) {
                return cb(new Error('Only images allowed (.png/.jpg/.jpeg/.webp)'));
            }
            cb(null, true);
        },
    });
}

/**
 * Express error handler for multer errors
 */
export function uploadErrorHandler(err, req, res, next) {
    if (err && (err.name === 'MulterError' || err.message?.startsWith('Only images'))) {
        return res.status(400).json({ message: err.message });
    }
    next(err);
}

// Pre-configured upload for profile images
export const profileUpload = createUpload('profile-images', 2);

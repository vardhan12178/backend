import express from "express";
import { body } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT, requireAdmin, optionalAuth } from "../middleware/auth.js";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { s3 } from "../utils/s3.js";
import * as productController from "../controllers/product.controller.js";

const router = express.Router();
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

//
// ────────────────────────────────────────────────────────────
//   UPLOAD CONFIG
// ────────────────────────────────────────────────────────────
//

const uploadProductImage = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET || "vkart-assets-mumbai",
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) =>
      cb(
        null,
        `product-images/${Date.now()}${path.extname(file.originalname)}`
      ),
    serverSideEncryption: "AES256",
  }),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(
        new Error("Only images allowed (.png/.jpg/.jpeg/.webp)")
      );
    }
    cb(null, true);
  },
});

function uploadProductError(err, req, res, next) {
  if (
    err &&
    (err.name === "MulterError" || err.message?.startsWith("Only images"))
  ) {
    return res.status(400).json({ message: err.message });
  }
  next(err);
}

//
// ────────────────────────────────────────────────────────────
//   PUBLIC ROUTES
// ────────────────────────────────────────────────────────────
//

/* List Products (optionalAuth for Prime sale pricing) */
router.get("/products", optionalAuth, productController.getProducts);

/* Search Autocomplete (before :id) */
router.get("/products/suggest", productController.suggestProducts);

/* Product Details (optionalAuth for Prime pricing) */
router.get("/products/:id", optionalAuth, productController.getProductById);

//
// ────────────────────────────────────────────────────────────
//   ADMIN ROUTES
// ────────────────────────────────────────────────────────────
//

/* Create Product */
router.post("/admin/products", authenticateJWT, requireAdmin, productController.createProduct);

/* Update Product */
router.put("/admin/products/:id", authenticateJWT, requireAdmin, productController.updateProduct);

/* Delete Product */
router.delete("/admin/products/:id", authenticateJWT, requireAdmin, productController.deleteProduct);

/* Admin List */
router.get("/admin/products", authenticateJWT, requireAdmin, productController.getAdminProducts);

/* Upload Image */
router.post(
  "/admin/products/upload",
  authenticateJWT,
  requireAdmin,
  uploadProductImage.single("image"),
  uploadProductError,
  productController.uploadProductImageHandler
);

//
// ────────────────────────────────────────────────────────────
//   REVIEW ROUTES
// ────────────────────────────────────────────────────────────
//

/* Add Review */
router.post("/products/:id/reviews", authenticateJWT, [
  body("rating").isInt({ min: 1, max: 5 }).withMessage("Rating must be 1-5"),
  body("comment").isString().trim().isLength({ min: 10, max: 1000 }).withMessage("Comment must be 10-1000 chars"),
], validate, productController.addReview);

/* List Reviews */
router.get("/products/:id/reviews", productController.getReviews);

/* Delete Review */
router.delete("/products/:id/reviews/:reviewId", authenticateJWT, productController.deleteReview);

export default router;
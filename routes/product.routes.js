import express from "express";
import Product from "../models/Product.js";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { s3 } from "../utils/s3.js";


const router = express.Router();
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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


/* ============================================================
   PUBLIC ROUTES  — FRONTEND USERS
   ============================================================ */

/**
 * GET /api/products
 * Supports:
 *   - search ?q=
 *   - category ?category=
 *   - price range ?minPrice=&maxPrice=
 *   - sort ?sort=price_asc | price_desc | newest
 *   - pagination ?page=&limit=
 */
router.get("/products", async (req, res) => {
  try {
    const {
      q = "",
      category,
      minPrice,
      maxPrice,
      sort = "newest",
      page = 1,
      limit = 20,
    } = req.query;

    const query = { isActive: true };

    if (q.trim()) {
      query.$text = { $search: q.trim() };
    }

    if (category) query.category = category;

    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }

    let sortObj = { createdAt: -1 }; // newest default
    if (sort === "price_asc") sortObj = { price: 1 };
    if (sort === "price_desc") sortObj = { price: -1 };

    const skip = (Number(page) - 1) * Number(limit);

    const products = await Product.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(Number(limit));

    const count = await Product.countDocuments(query);

    res.json({
      products,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("Products list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/products/:id
 * Product details
 */
router.get("/products/:id", async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: "Product not found" });

    res.json(p);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/products/:id/reviews
 * Add review — must be logged in
 */
router.post("/products/:id/reviews", authenticateJWT, async (req, res) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Invalid rating" });
    }

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const review = {
      rating,
      comment: comment || "",
      userId: req.user.userId,
      reviewerName: req.user.userId, // replace with user's name later if needed
      reviewerEmail: "", // optional
      date: new Date(),
    };

    product.reviews.push(review);

    // Auto-update rating (avg)
    const ratings = product.reviews.map((r) => r.rating);
    product.rating = ratings.reduce((a, b) => a + b, 0) / ratings.length;

    await product.save();

    res.json({ message: "Review added", review });
  } catch (err) {
    console.error("Add review error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   ADMIN ROUTES  — ADMIN DASHBOARD
   ============================================================ */

/**
 * POST /api/admin/products
 * Create product
 */
router.post(
  "/admin/products",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const data = req.body;
      data.createdBy = req.user.userId;

      const product = await Product.create(data);
      res.status(201).json({ message: "Product created", product });
    } catch (err) {
      console.error("Create product error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * PUT /api/admin/products/:id
 * Update product
 */
router.put(
  "/admin/products/:id",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const updated = await Product.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true }
      );

      if (!updated)
        return res.status(404).json({ error: "Product not found" });

      res.json({ message: "Product updated", product: updated });
    } catch (err) {
      console.error("Update product error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * DELETE /api/admin/products/:id
 * Delete product
 */
router.delete(
  "/admin/products/:id",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const deleted = await Product.findByIdAndDelete(req.params.id);

      if (!deleted)
        return res.status(404).json({ error: "Product not found" });

      res.json({ message: "Product deleted" });
    } catch (err) {
      console.error("Delete product error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * GET /api/admin/products
 * List products for admin (no filters)
 */
router.get(
  "/admin/products",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const list = await Product.find().sort({ createdAt: -1 });
      res.json(list);
    } catch (err) {
      console.error("Admin list products error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);


/**
 * POST /api/admin/products/upload
 * Upload product image to S3
 */
router.post(
  "/admin/products/upload",
  authenticateJWT,
  requireAdmin,
  uploadProductImage.single("image"),
  uploadProductError,
  (req, res) => {
    try {
      if (!req.file?.location) {
        return res.status(400).json({ message: "No image uploaded" });
      }

      return res.json({
        url: req.file.location,
        key: req.file.key,
        message: "Image uploaded successfully",
      });
    } catch (err) {
      console.error("Product image upload error:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

export default router;

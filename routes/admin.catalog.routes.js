import express from "express";
import { body, param, query } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as reviews from "../controllers/catalogReviews.controller.js";
import * as admin from "../controllers/admin.catalog.controller.js";
import { STATUSES } from "../services/catalog.admin.js";

// Catalog admin, mounted at /api/admin/v2. Uses the "products" admin permission.
const router = express.Router();
const read = [authenticateJWT, requirePermission("products", "read")];
const write = [authenticateJWT, requirePermission("products", "write")];
const id = param("id").isMongoId();

router.get(
  "/products",
  read,
  [
    query("q").optional().isString().isLength({ max: 80 }),
    query("category")
      .optional()
      .isString()
      .matches(/^[a-z-]{1,40}$/),
    query("status").optional().isIn(STATUSES),
    query("stock").optional().isIn(["low", "out"]),
    query("sort").optional().isIn(["updated", "title", "stock"]),
    query("page").optional().isInt({ min: 1, max: 1000 }),
    query("limit").optional().isInt({ min: 1, max: 50 }),
  ],
  validate,
  admin.listProducts
);

// Bulk status: { ids: [..] } or { ids: "all", filter: { q, category, status, stock } }
router.post(
  "/products/bulk-status",
  write,
  [
    body("status").isIn(STATUSES),
    body("ids").custom((v) => v === "all" || (Array.isArray(v) && v.length <= 500)),
    body("ids.*").optional().isMongoId(),
    body("filter").optional().isObject(),
    body("filter.q").optional().isString().isLength({ max: 80 }),
    body("filter.category")
      .optional()
      .isString()
      .matches(/^[a-z-]{1,40}$/),
    body("filter.status").optional().isIn(STATUSES),
    body("filter.stock").optional().isIn(["low", "out"]),
  ],
  validate,
  admin.bulkStatus
);

router.patch(
  "/products/:id",
  write,
  [
    id,
    body("status").optional().isIn(STATUSES),
    body("isFeatured").optional().isBoolean().toBoolean(),
  ],
  validate,
  admin.patchProduct
);

router.patch(
  "/products/:id/variants/:sku",
  write,
  [
    id,
    param("sku").isString().isLength({ min: 1, max: 80 }),
    body("price").optional().isInt({ min: 1, max: 10000000 }).toInt(),
    body("mrp").optional().isInt({ min: 1, max: 10000000 }).toInt(),
    body("stock").optional().isInt({ min: 0, max: 100000 }).toInt(),
  ],
  validate,
  admin.patchVariant
);

// Shopper review moderation uses the "reviews" admin permission
const reviewsRead = [authenticateJWT, requirePermission("reviews", "read")];
const reviewsWrite = [authenticateJWT, requirePermission("reviews", "write")];
router.get(
  "/reviews",
  reviewsRead,
  [
    query("status").optional().isIn(["published", "hidden"]),
    query("page").optional().isInt({ min: 1, max: 1000 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  validate,
  reviews.adminList
);
router.patch(
  "/reviews/:id",
  reviewsWrite,
  [param("id").isMongoId(), body("status").isIn(["published", "hidden"])],
  validate,
  reviews.adminSetStatus
);

export default router;

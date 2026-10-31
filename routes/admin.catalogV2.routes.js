import express from "express";
import { body, param, query } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as admin from "../controllers/admin.catalogV2.controller.js";
import { STATUSES } from "../services/catalogV2.admin.js";

// Catalog v2 admin, mounted at /api/admin/v2. Uses the same "products" permission as the v1 admin.
const router = express.Router();
const read = [authenticateJWT, requirePermission("products", "read")];
const write = [authenticateJWT, requirePermission("products", "write")];
const id = param("id").isMongoId();

router.get(
  "/products",
  read,
  [
    query("q").optional().isString().isLength({ max: 80 }),
    query("category").optional().isString().matches(/^[a-z-]{1,40}$/),
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
    body("filter.category").optional().isString().matches(/^[a-z-]{1,40}$/),
    body("filter.status").optional().isIn(STATUSES),
    body("filter.stock").optional().isIn(["low", "out"]),
  ],
  validate,
  admin.bulkStatus
);

router.patch(
  "/products/:id",
  write,
  [id, body("status").optional().isIn(STATUSES), body("isFeatured").optional().isBoolean().toBoolean()],
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

export default router;

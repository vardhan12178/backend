import express from "express";
import { param, query } from "express-validator";
import validate from "../middleware/validate.js";
import * as catalogV2 from "../controllers/catalogV2.controller.js";
import { SORT_KEYS, MAX_PAGE_SIZE } from "../services/catalogV2.service.js";

// Mounted at /api/v2 (CATALOG_V2_SCHEMA.md §8)
const router = express.Router();

const slug = param("slug").isString().trim().matches(/^[a-z0-9-]{1,160}$/).withMessage("Invalid slug");

router.get("/categories", catalogV2.getCategories);

router.get(
  "/products",
  [
    query("category").optional().isString().trim().isLength({ max: 60 }),
    query("brand").optional().isString().isLength({ max: 400 }),
    query("minPrice").optional().isInt({ min: 0 }).toInt(),
    query("maxPrice").optional().isInt({ min: 0 }).toInt(),
    query("minDiscount").optional().isInt({ min: 0, max: 100 }).toInt(),
    query("inStock").optional().isIn(["true", "false"]),
    query("q").optional().isString().isLength({ max: 100 }),
    query("sort").optional().isIn(SORT_KEYS),
    query("page").optional().isInt({ min: 1, max: 1000 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
  ],
  validate,
  catalogV2.listProducts
);

router.get("/products/:slug", [slug], validate, catalogV2.getProduct);
router.get("/products/:slug/similar", [slug, query("limit").optional().isInt({ min: 1, max: 24 }).toInt()], validate, catalogV2.getSimilar);

export default router;

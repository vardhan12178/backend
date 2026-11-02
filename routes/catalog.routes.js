import express from "express";
import { body, param, query } from "express-validator";
import validate from "../middleware/validate.js";
import { optionalAuth, authenticateJWT } from "../middleware/auth.js";
import * as reviews from "../controllers/catalogReviews.controller.js";
import * as catalog from "../controllers/catalog.controller.js";
import { SORT_KEYS, MAX_PAGE_SIZE } from "../services/catalog.service.js";

// Mounted at /api/v2 (docs/CATALOG_SCHEMA.md §8)
const router = express.Router();

const slug = param("slug").isString().trim().matches(/^[a-z0-9-]{1,160}$/).withMessage("Invalid slug");

router.get("/categories", catalog.getCategories);

router.get(
  "/products",
  [
    query("category").optional().isString().trim().isLength({ max: 60 }),
    query("brand").optional().isString().isLength({ max: 400 }),
    query("minPrice").optional().isInt({ min: 0 }).toInt(),
    query("maxPrice").optional().isInt({ min: 0 }).toInt(),
    query("minDiscount").optional().isInt({ min: 0, max: 100 }).toInt(),
    query("minRating").optional().isFloat({ min: 0, max: 5 }).toFloat(),
    query("inStock").optional().isIn(["true", "false"]),
    query("q").optional().isString().isLength({ max: 100 }),
    query("sort").optional().isIn(SORT_KEYS),
    query("page").optional().isInt({ min: 1, max: 1000 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
  ],
  validate,
  catalog.listProducts
);

router.get("/products/:slug", [slug], validate, catalog.getProduct);
// Shopper reviews: anyone can read; only shoppers whose order was delivered can write
const reviewBody = [
  body("stars").isInt({ min: 1, max: 5 }).toInt(),
  body("title").optional({ values: "falsy" }).isString().isLength({ max: 80 }),
  body("body").isString().trim().isLength({ min: 10, max: 1500 }).withMessage("Write at least 10 characters"),
];
const reviewId = param("id").isMongoId();
router.get("/products/:slug/reviews", optionalAuth, [slug, query("sort").optional().isIn(["recent", "helpful", "high", "low"]), query("page").optional().isInt({ min: 1, max: 500 }).toInt(), query("limit").optional().isInt({ min: 1, max: 30 }).toInt()], validate, reviews.list);
router.post("/products/:slug/reviews", authenticateJWT, [slug, ...reviewBody], validate, reviews.create);
router.put("/reviews/:id", authenticateJWT, [reviewId, body("stars").optional().isInt({ min: 1, max: 5 }).toInt(), body("title").optional().isString().isLength({ max: 80 }), body("body").optional().isString().trim().isLength({ min: 10, max: 1500 })], validate, reviews.update);
router.delete("/reviews/:id", authenticateJWT, [reviewId], validate, reviews.remove);
router.post("/reviews/:id/helpful", authenticateJWT, [reviewId], validate, reviews.helpful);

router.get("/products/:slug/similar", [slug, query("limit").optional().isInt({ min: 1, max: 24 }).toInt()], validate, catalog.getSimilar);

// Delivery estimate for a PIN code (and optionally the storefront category, for large items)
router.get(
  "/delivery/:pincode",
  [
    param("pincode").isString().trim().isLength({ min: 1, max: 12 }),
    query("category").optional().isString().trim().matches(/^[a-z-]{1,40}$/),
  ],
  validate,
  catalog.getDelivery
);

router.post(
  "/cart/resolve",
  optionalAuth,
  [
    body("items").isArray({ max: 100 }),
    body("items.*.productId").isMongoId(),
    body("items.*.sku").isString().isLength({ min: 1, max: 80 }),
    body("items.*.quantity").optional().isInt({ min: 1, max: 99 }).toInt(),
  ],
  validate,
  catalog.resolveCart
);

export default router;

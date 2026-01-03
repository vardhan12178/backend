import express from "express";
import { body } from "express-validator";
import { STAGES } from "../models/Order.js";
import { authenticateJWT } from "../middleware/auth.js";
import * as orderController from "../controllers/order.controller.js";

const router = express.Router();

//
// ────────────────────────────────────────────────────────────
//   VALIDATION CONFIG
// ────────────────────────────────────────────────────────────
//

const validateOrder = [
  body("products").isArray({ min: 1 }),

  body("products.*.productId").optional({ nullable: true }).isMongoId(),
  body("products.*.externalId").optional({ nullable: true }).isString(),

  body("products").custom((arr) =>
    Array.isArray(arr) && arr.every((p) => p.productId || p.externalId)
  ),

  body("products.*.name").isString(),
  body("products.*.image").optional({ nullable: true }).isString(),
  body("products.*.quantity").isInt({ gt: 0 }),
  body("products.*.price").isFloat({ gt: 0 }),

  body("tax").optional().isFloat({ min: 0 }),
  body("shipping").optional().isFloat({ min: 0 }),
  body("totalPrice").optional().isFloat({ gt: 0 }),

  body("stage")
    .optional()
    .customSanitizer((v) => (typeof v === "string" ? v.toUpperCase() : v))
    .isIn(STAGES),

  body("shippingAddress").isString(),
];

//
// ────────────────────────────────────────────────────────────
//   ROUTES
// ────────────────────────────────────────────────────────────
//

/* CREATE ORDER (USER) */
router.post("/orders", authenticateJWT, validateOrder, orderController.createOrder);

/* CUSTOMER — GET ALL ORDERS */
router.get("/profile/orders", authenticateJWT, orderController.getUserOrders);

/* CUSTOMER — PAGINATED ORDERS */
router.get("/profile/orders/paged", authenticateJWT, orderController.getUserOrdersPaged);

/* ADMIN — GET ALL ORDERS */
router.get("/admin/orders", authenticateJWT, orderController.getAllOrders);

/* ADMIN — GET ORDER BY ID */
router.get("/admin/orders/:id", authenticateJWT, orderController.getOrderById);

/* ADMIN — UPDATE ORDER STAGE */
router.patch(
  "/admin/orders/:id/stage",
  authenticateJWT,
  body("stage")
    .customSanitizer((v) => v.toUpperCase())
    .isIn(STAGES),
  orderController.updateOrderStage
);

export default router;

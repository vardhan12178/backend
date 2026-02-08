import express from "express";
import { body } from "express-validator";
import { STAGES } from "../models/Order.js";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
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
  body("paymentStatus").optional().isIn(["PAID", "PENDING", "FAILED"]),
  body("paymentMethod").optional().isIn(["CARD", "UPI", "COD", "WALLET"]),
  body("paymentId").optional().isString(),
  body("paymentOrderId").optional().isString(),
  body("walletUsed").optional().isFloat({ min: 0 }),

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

/* CUSTOMER — REQUEST RETURN */
router.post(
  "/orders/:id/return",
  authenticateJWT,
  body("reason").isString().isLength({ min: 3 }),
  body("returnType").optional().isIn(["REFUND", "REPLACEMENT"]),
  body("refundMethod").optional().isIn(["WALLET", "ORIGINAL"]),
  orderController.requestReturn
);

/* CUSTOMER — CANCEL ORDER */
router.post(
  "/orders/:id/cancel",
  authenticateJWT,
  body("reason").isString().isLength({ min: 3 }),
  body("refundMethod").optional().isIn(["WALLET", "ORIGINAL"]),
  orderController.cancelOrder
);

/* CUSTOMER/ADMIN — DOWNLOAD INVOICE */
router.get("/orders/:id/invoice", authenticateJWT, orderController.downloadInvoice);

/* ADMIN — GET ALL ORDERS */
router.get("/admin/orders", authenticateJWT, requireAdmin, orderController.getAllOrders);

/* ADMIN — GET ORDER BY ID */
router.get("/admin/orders/:id", authenticateJWT, requireAdmin, orderController.getOrderById);

/* ADMIN — UPDATE ORDER STAGE */
router.patch(
  "/admin/orders/:id/stage",
  authenticateJWT,
  requireAdmin,
  body("stage")
    .customSanitizer((v) => v.toUpperCase())
    .isIn(STAGES),
  orderController.updateOrderStage
);

/* ADMIN — UPDATE RETURN STATUS */
router.patch(
  "/admin/orders/:id/return",
  authenticateJWT,
  requireAdmin,
  body("status").isString(),
  orderController.updateReturnStatus
);

/* ADMIN — INITIATE REFUND */
router.post(
  "/admin/orders/:id/refund",
  authenticateJWT,
  requireAdmin,
  body("method").isIn(["WALLET", "ORIGINAL"]),
  orderController.initiateRefund
);

/* ADMIN — CREATE REPLACEMENT ORDER */
router.post(
  "/admin/orders/:id/replacement",
  authenticateJWT,
  requireAdmin,
  orderController.createReplacementOrder
);

export default router;

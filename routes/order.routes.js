import express from "express";
import { body } from "express-validator";
import { STAGES } from "../models/Order.js";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import * as orderController from "../controllers/order.controller.js";

const router = express.Router();
// Express 4 needs explicit promise rejection forwarding for async handlers.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

//
// ────────────────────────────────────────────────────────────
//   VALIDATION CONFIG
// ────────────────────────────────────────────────────────────
//

const validateOrder = [
  body("products").isArray({ min: 1 }),

  body("products.*.productId").isMongoId(),

  body("products.*.name").isString(),
  body("products.*.image").optional({ nullable: true }).isString(),
  body("products.*.quantity").isInt({ gt: 0 }),
  body("products.*.price").optional().isFloat({ gt: 0 }),
  body("products.*.selectedVariants").optional({ nullable: true }).isString(),

  body("promo").optional({ nullable: true }).isString(),
  body("paymentVerificationToken").optional({ nullable: true }).isString(),
  body("walletUsed").optional().isFloat({ min: 0 }),

  body("shippingAddress").isString(),
];

//
// ────────────────────────────────────────────────────────────
//   ROUTES
// ────────────────────────────────────────────────────────────
//

/* CREATE ORDER (USER) */
router.post("/orders", authenticateJWT, validateOrder, asyncHandler(orderController.createOrder));

/* CUSTOMER — GET ALL ORDERS */
router.get("/profile/orders", authenticateJWT, asyncHandler(orderController.getUserOrders));

/* CUSTOMER — PAGINATED ORDERS */
router.get("/profile/orders/paged", authenticateJWT, asyncHandler(orderController.getUserOrdersPaged));

/* CUSTOMER — REQUEST RETURN */
router.post(
  "/orders/:id/return",
  authenticateJWT,
  body("reason").isString().isLength({ min: 3 }),
  body("returnType").optional().isIn(["REFUND", "REPLACEMENT"]),
  body("refundMethod").optional().isIn(["WALLET", "ORIGINAL"]),
  asyncHandler(orderController.requestReturn)
);

/* CUSTOMER — CANCEL ORDER */
router.post(
  "/orders/:id/cancel",
  authenticateJWT,
  body("reason").isString().isLength({ min: 3 }),
  body("refundMethod").optional().isIn(["WALLET", "ORIGINAL"]),
  asyncHandler(orderController.cancelOrder)
);

/* CUSTOMER/ADMIN — DOWNLOAD INVOICE */
router.get("/orders/:id/invoice", authenticateJWT, asyncHandler(orderController.downloadInvoice));

/* ADMIN — GET ALL ORDERS */
router.get("/admin/orders", authenticateJWT, requireAdmin, asyncHandler(orderController.getAllOrders));

/* ADMIN — GET ORDER BY ID */
router.get("/admin/orders/:id", authenticateJWT, requireAdmin, asyncHandler(orderController.getOrderById));

/* ADMIN — UPDATE ORDER STAGE */
router.patch(
  "/admin/orders/:id/stage",
  authenticateJWT,
  requireAdmin,
  body("stage")
    .customSanitizer((v) => v.toUpperCase())
    .isIn(STAGES),
  asyncHandler(orderController.updateOrderStage)
);

/* ADMIN — UPDATE RETURN STATUS */
router.patch(
  "/admin/orders/:id/return",
  authenticateJWT,
  requireAdmin,
  body("status").isString(),
  asyncHandler(orderController.updateReturnStatus)
);

/* ADMIN — INITIATE REFUND */
router.post(
  "/admin/orders/:id/refund",
  authenticateJWT,
  requireAdmin,
  body("method").isIn(["WALLET", "ORIGINAL"]),
  asyncHandler(orderController.initiateRefund)
);

/* ADMIN — CREATE REPLACEMENT ORDER */
router.post(
  "/admin/orders/:id/replacement",
  authenticateJWT,
  requireAdmin,
  asyncHandler(orderController.createReplacementOrder)
);

export default router;

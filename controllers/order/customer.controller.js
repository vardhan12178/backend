import { validationResult } from "express-validator";
import mongoose from "mongoose";
import Order from "../../models/Order.js";
import User from "../../models/User.js";
import { createNotification } from "../admin.notifications.controller.js";
import { createUserNotification } from "../user.notifications.controller.js";
import { sendEmail, emailTemplate } from "../../services/email.service.js";
import { refundPaymentViaRazorpay } from "../../services/refund.service.js";
import { isCatalogLine, restoreLine } from "../../services/catalog.stock.js";

/* GET ALL ORDERS (User) */
export const getUserOrders = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).populate("orders").lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(user.orders);
  } catch (err) {
    console.error("getUserOrders error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* PAGINATED ORDERS (User) */
export const getUserOrdersPaged = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Order.find({ userId: req.user.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments({ userId: req.user.userId }),
    ]);

    res.json({ page, limit, total, items });
  } catch (err) {
    console.error("getUserOrdersPaged error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* CUSTOMER - REQUEST RETURN */
export const requestReturn = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (String(order.userId) !== String(req.user.userId)) {
    return res.status(403).json({ message: "Unauthorized" });
  }
  if (order.stage !== "DELIVERED") {
    return res.status(400).json({ message: "Return allowed only after delivery" });
  }
  if (order.returnStatus !== "NONE" && order.returnStatus !== "REJECTED") {
    return res.status(400).json({ message: "Return already requested" });
  }

  const reason = String(req.body.reason || "").trim();
  const refundMethod = String(req.body.refundMethod || "ORIGINAL").toUpperCase();
  const returnType = String(req.body.returnType || "REFUND").toUpperCase();

  order.returnStatus = "REQUESTED";
  order.returnReason = reason;
  order.returnType = returnType === "REPLACEMENT" ? "REPLACEMENT" : "REFUND";
  if (order.returnType === "REFUND") {
    order.refundMethod = refundMethod === "WALLET" ? "WALLET" : "ORIGINAL";
    order.refundAmount = order.totalPrice || 0;
    order.refundStatus = order.refundStatus || "NONE";
  } else {
    order.refundMethod = undefined;
    order.refundAmount = 0;
    order.refundStatus = "NONE";
  }
  order.returnHistory.push({ status: "REQUESTED", note: reason });

  await order.save();

  createNotification(
    "return",
    `Return requested for ${order.orderId || order._id}`,
    `User requested return. Reason: ${reason}`,
    "/admin/orders"
  );

  return res.json({ message: "Return requested", order });
};

/* CUSTOMER - CANCEL ORDER */
export const cancelOrder = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (String(order.userId) !== String(req.user.userId)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const nonCancelable = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];
  if (nonCancelable.includes(order.stage)) {
    return res.status(400).json({ message: "Order cannot be cancelled now" });
  }

  const reason = String(req.body.reason || "").trim();
  const refundMethod = String(req.body.refundMethod || "ORIGINAL").toUpperCase();

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    order.stage = "CANCELLED";
    order.cancelReason = reason;
    order.statusHistory.push({ stage: "CANCELLED", note: reason });
    order.returnType = "REFUND";

    // Restore stock for each product
    for (const p of order.products) {
      if (isCatalogLine(p)) await restoreLine(p, session);
    }

    if (order.paymentStatus === "PAID") {
      order.refundMethod = refundMethod === "WALLET" ? "WALLET" : "ORIGINAL";
      order.refundAmount = order.totalPrice || 0;

      if (order.refundMethod === "WALLET") {
        const user = await User.findById(order.userId).session(session);
        if (user) {
          user.walletBalance = Math.round((user.walletBalance + order.refundAmount) * 100) / 100;
          user.walletTransactions.push({
            type: "CREDIT",
            amount: order.refundAmount,
            reason: "Order cancellation refund",
            orderId: order._id,
          });
          await user.save({ session });
        }
        order.refundStatus = "COMPLETED";
      }
      // ORIGINAL-method refund is deliberately NOT attempted inside this
      // transaction: an external Razorpay API call has no place holding a
      // DB transaction open. It's handled just below, after commit.
    }

    await order.save({ session });
    await session.commitTransaction();
  } catch (err) {
    // Mirrors createOrder/createReplacementOrder: only abort if the session
    // is still in a transaction. Calling abortTransaction() unconditionally
    // is wrong when the error came from commitTransaction() itself (e.g. a
    // transient commit failure): the driver rejects an abort attempted
    // after a commit was already attempted, which previously masked the
    // real error behind a confusing "Cannot call abortTransaction after
    // calling commitTransaction" crash that bypassed this handler's own
    // 500 response entirely.
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error("Cancel order error:", err);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    session.endSession();
  }

  if (
    order.paymentStatus === "PAID" &&
    order.refundMethod === "ORIGINAL" &&
    order.refundStatus !== "COMPLETED"
  ) {
    if (order.paymentId) {
      try {
        const refund = await refundPaymentViaRazorpay(order, {
          reason: "Order cancellation refund",
        });
        order.refundId = refund.id;
        order.refundStatus = refund.status === "processed" ? "COMPLETED" : "INITIATED";
        if (order.refundStatus === "COMPLETED") order.returnStatus = "CLOSED";
      } catch (err) {
        console.error("Razorpay refund error (cancel):", err.message);
        order.refundStatus = "FAILED";
      }
    } else {
      // No real gateway payment on record (legacy/COD order), fall back to
      // the manual placeholder the nightly scheduler resolves.
      order.refundStatus = "INITIATED";
      order.refundDueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
    await order.save();
  }

  createUserNotification(
    order.userId,
    "order",
    "Order cancelled",
    "Your order has been cancelled.",
    `/orders/${order.orderId}`
  );

  if (order.customer?.email) {
    await sendEmail({
      to: order.customer.email,
      subject: "Order cancelled",
      html: emailTemplate({
        title: "Order cancelled",
        body: "Your order has been cancelled. Any refund will be processed as selected.",
      }),
    });
  }

  return res.json({ message: "Order cancelled", order });
};

import { validationResult } from "express-validator";
import mongoose from "mongoose";
import Order from "../../models/Order.js";
import User from "../../models/User.js";
import { createNotification } from "../admin.notifications.controller.js";
import { createUserNotification } from "../user.notifications.controller.js";
import { sendEmail, emailTemplate } from "../../services/email.service.js";
import { refundPaymentViaRazorpay } from "../../services/refund.service.js";
import { isCatalogLine, reserveLine, restoreLine } from "../../services/catalog.stock.js";

/* ADMIN - GET ALL ORDERS */
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find({ isDemo: { $ne: true } })
      .sort({ createdAt: -1 })
      .lean();
    res.json(orders);
  } catch (err) {
    console.error("getAllOrders error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* ADMIN - GET ORDER BY ID */
export const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    res.json(order);
  } catch (err) {
    console.error("getOrderById error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* ADMIN - UPDATE ORDER STAGE */
export const updateOrderStage = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });

  const newStage = req.body.stage;

  // Cannot update completed orders
  if (["DELIVERED", "CANCELLED"].includes(order.stage)) {
    return res.status(400).json({
      message: "Order is already completed or cancelled.",
    });
  }

  // Update stage
  order.stage = newStage;

  // Push timeline entry
  order.statusHistory.push({
    stage: newStage,
    date: new Date(),
  });

  await order.save();

  // Notify user about status change
  const productNames = order.products.map((p) => p.name);
  const displayNames =
    productNames.length > 2
      ? `${productNames.slice(0, 2).join(", ")} +${productNames.length - 2} more`
      : productNames.join(", ");

  const stageMessages = {
    CONFIRMED: {
      title: "Order Confirmed",
      message: `Your order for ${displayNames} has been confirmed.`,
    },
    SHIPPED: {
      title: "Order Shipped",
      message: `Your order for ${displayNames} is on its way.`,
    },
    OUT_FOR_DELIVERY: {
      title: "Out for Delivery",
      message: `Your order for ${displayNames} will arrive today.`,
    },
    DELIVERED: {
      title: "Order Delivered",
      message: `Your order for ${displayNames} has been delivered.`,
    },
    CANCELLED: {
      title: "Order Cancelled",
      message: `Your order for ${displayNames} was cancelled.`,
    },
  };

  const msgData = stageMessages[newStage];
  if (msgData) {
    createUserNotification(
      order.userId,
      "order",
      msgData.title,
      msgData.message,
      `/orders/${order.orderId}`
    );

    if (order.customer?.email) {
      await sendEmail({
        to: order.customer.email,
        subject: msgData.title,
        html: emailTemplate({
          title: msgData.title,
          body: msgData.message,
        }),
      });
    }
  }

  res.json({
    message: "Order stage updated successfully",
    order,
  });
};

/* ADMIN - UPDATE RETURN STATUS */
export const updateReturnStatus = async (req, res) => {
  const status = String(req.body.status || "").toUpperCase();
  const allowed = ["APPROVED", "PICKED", "RECEIVED", "REJECTED", "CLOSED"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: "Invalid return status" });
  }

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });

  // Nothing to progress if the customer never actually requested a return.
  // Without this, an admin could e.g. click "Set RECEIVED" on an untouched
  // order and have it restore stock for an item that was never returned.
  if (order.returnStatus === "NONE") {
    return res.status(400).json({ message: "No return has been requested for this order yet." });
  }

  order.returnStatus = status;
  order.returnHistory.push({ status });

  // Restore stock when return is received
  if (status === "RECEIVED") {
    for (const p of order.products) {
      if (isCatalogLine(p)) await restoreLine(p);
    }
  }

  await order.save();

  createUserNotification(
    order.userId,
    "return",
    `Return ${status}`,
    `Your return status is now ${status}.`,
    `/orders/${order.orderId}`
  );

  if (order.customer?.email) {
    await sendEmail({
      to: order.customer.email,
      subject: `Return ${status}`,
      html: emailTemplate({
        title: `Return ${status}`,
        body: `Your return status is now ${status}.`,
      }),
    });
  }

  return res.json({ message: "Return status updated", order });
};

/* ADMIN - INITIATE REFUND */
export const initiateRefund = async (req, res) => {
  const method = String(req.body.method || "").toUpperCase();
  if (!["WALLET", "ORIGINAL"].includes(method)) {
    return res.status(400).json({ message: "Invalid refund method" });
  }

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });

  if (order.refundStatus !== "NONE" && order.refundStatus !== "FAILED") {
    return res.status(400).json({ message: "Refund already initiated" });
  }

  // A refund needs an actual reason on record: the order was cancelled, or
  // the customer's return has been approved and is on its way back (or
  // already received). Without this, nothing stopped an admin from issuing
  // a refund on any order: including one that was never cancelled or
  // returned at all.
  const eligible =
    order.stage === "CANCELLED" || ["APPROVED", "PICKED", "RECEIVED"].includes(order.returnStatus);
  if (!eligible) {
    return res.status(400).json({
      message:
        "This order isn't eligible for a refund yet — it must be cancelled, or have an approved return.",
    });
  }

  order.refundMethod = method;
  order.refundAmount = order.totalPrice || 0;

  if (method === "WALLET") {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const user = await User.findById(order.userId).session(session);
      if (!user) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: "User not found" });
      }
      user.walletBalance = Math.round((user.walletBalance + order.refundAmount) * 100) / 100;
      user.walletTransactions.push({
        type: "CREDIT",
        amount: order.refundAmount,
        reason: "Refund",
        orderId: order._id,
      });
      await user.save({ session });

      order.refundStatus = "COMPLETED";
      order.returnStatus = "CLOSED";
      await order.save({ session });
      await session.commitTransaction();
      session.endSession();
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      console.error("Refund wallet error:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  } else if (order.paymentId) {
    try {
      const refund = await refundPaymentViaRazorpay(order, {
        reason: order.returnReason || "Return refund",
      });
      order.refundId = refund.id;
      order.refundStatus = refund.status === "processed" ? "COMPLETED" : "INITIATED";
      if (order.refundStatus === "COMPLETED") order.returnStatus = "CLOSED";
      await order.save();
    } catch (err) {
      console.error("Razorpay refund error:", err.message);
      order.refundStatus = "FAILED";
      await order.save();
    }
  } else {
    // No real gateway payment on record (legacy/COD order), fall back to
    // the manual placeholder the nightly scheduler resolves.
    order.refundStatus = "INITIATED";
    order.refundDueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await order.save();
  }

  const refundStatusCopy =
    order.refundStatus === "COMPLETED"
      ? "completed"
      : order.refundStatus === "FAILED"
        ? "could not be processed — our team will follow up"
        : "initiated";

  createUserNotification(
    order.userId,
    "refund",
    order.refundStatus === "FAILED" ? "Refund issue" : "Refund initiated",
    `Your refund has been ${refundStatusCopy}.`,
    `/orders/${order.orderId}`
  );

  createNotification(
    "refund",
    `Refund ${order.refundStatus.toLowerCase()}`,
    `Refund ${order.refundStatus.toLowerCase()} for ${order.orderId || order._id}`,
    "/admin/orders"
  );

  if (order.customer?.email) {
    await sendEmail({
      to: order.customer.email,
      subject: "Refund update",
      html: emailTemplate({
        title: "Refund update",
        body: `Your refund has been ${refundStatusCopy}.`,
      }),
    });
  }

  return res.json({ message: "Refund updated", order });
};

/* ADMIN - CREATE REPLACEMENT ORDER */
export const createReplacementOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(req.params.id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.returnType !== "REPLACEMENT") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Not a replacement return" });
    }
    if (order.replacementOrderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Replacement already created" });
    }

    // Inventory enforcement
    for (const p of order.products) {
      if (!p.productId) continue;
      if (isCatalogLine(p)) {
        try {
          await reserveLine({ productId: p.productId, sku: p.sku, quantity: p.quantity }, session);
        } catch (err) {
          await session.abortTransaction();
          if (err.status === 400) return res.status(400).json({ message: err.message });
          throw err;
        }
        continue;
      }
      await session.abortTransaction();
      return res.status(400).json({ message: "Product unavailable for replacement" });
    }

    const replacement = new Order({
      userId: order.userId,
      customer: order.customer,
      products: order.products,
      tax: order.tax,
      shipping: order.shipping,
      stage: "PLACED",
      shippingAddress: order.shippingAddress,
      paymentStatus: "PAID",
      paymentMethod: "WALLET",
      walletUsed: 0,
      promo: "REPLACEMENT",
      replacementFromId: order._id,
    });

    await replacement.save({ session });
    order.replacementOrderId = replacement._id;
    await order.save({ session });

    await session.commitTransaction();

    createUserNotification(
      order.userId,
      "order",
      "Replacement created",
      "A replacement order has been created and will be shipped soon.",
      `/orders/${replacement.orderId}`
    );

    if (order.customer?.email) {
      await sendEmail({
        to: order.customer.email,
        subject: "Replacement order created",
        html: emailTemplate({
          title: "Replacement order created",
          body: "Your replacement order has been created and will be shipped soon.",
        }),
      });
    }

    return res.json({ message: "Replacement created", replacement });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("Replacement create error:", err);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    session.endSession();
  }
};

import { validationResult } from "express-validator";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import { createNotification } from "./admin.notifications.controller.js";
import { createUserNotification } from "./user.notifications.controller.js";
import { sendEmail, emailTemplate } from "../services/email.service.js";
import { applyCoupon, recordCouponUsage } from "./coupon.controller.js";
import { getActiveSale, overlaySalePricing } from "./sale.controller.js";
import {
  consumeCheckoutVerificationToken,
  getCheckoutVerificationToken,
} from "../services/payment.session.service.js";
import PDFDocument from "pdfkit";

const TAX_RATE = 0.18;
const FREE_SHIPPING_THRESHOLD = 999;
const FLAT_SHIPPING_FEE = 50;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const INCLUDED_TAX_RATE = TAX_RATE / (1 + TAX_RATE);
const toIdString = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (typeof v.toHexString === "function") return v.toHexString();
    if (typeof v.$oid === "string") return v.$oid;
    if (typeof v.id === "string") return v.id;
    if (v._id) return toIdString(v._id);
  }
  return String(v);
};

/* CREATE ORDER */
export const createOrder = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { products, shippingAddress } = req.body;
  const walletRequested = Math.max(0, Number(req.body.walletUsed) || 0);
  const promoCode = typeof req.body.promo === "string" ? req.body.promo.trim() : null;
  const paymentVerificationToken =
    typeof req.body.paymentVerificationToken === "string"
      ? req.body.paymentVerificationToken.trim()
      : "";
  const authUserId = toIdString(req.user.userId);
  let paymentTokenToConsume = "";

  const session = await mongoose.startSession();
  session.startTransaction();

  const abortWith = async (status, payload) => {
    await session.abortTransaction();
    session.endSession();
    return res.status(status).json(payload);
  };

  try {
    const user = await User.findById(authUserId).session(session);
    if (!user) return abortWith(404, { message: "User not found" });

    const activeSale = await getActiveSale();
    const isPrime =
      !!(user.membership?.endDate && new Date() < new Date(user.membership.endDate));

    // Inventory + canonical product prices come from DB.
    const normalizedProducts = [];
    let saleApplied = false;
    let saleId = null;
    let saleName = null;

    for (const p of products) {
      const qty = Math.max(1, Math.trunc(Number(p.quantity) || 0));
      const product = await Product.findById(p.productId)
        .select("title thumbnail images category price discountPercentage stock isActive")
        .session(session);

      if (!product || !product.isActive) {
        return abortWith(400, { message: "Product unavailable" });
      }
      if (product.stock < qty) {
        return abortWith(400, { message: `Insufficient stock for ${product.title}` });
      }

      product.stock -= qty;
      await product.save({ session });

      const productSnapshot = {
        _id: product._id,
        title: product.title,
        thumbnail: product.thumbnail,
        images: product.images,
        category: product.category,
        price: product.price,
        discountPercentage: Number(product.discountPercentage) || 0,
      };

      const overlaidProduct = activeSale
        ? overlaySalePricing([productSnapshot], activeSale, isPrime)[0]
        : productSnapshot;

      const unitPrice = round2(overlaidProduct?.price ?? product.price);
      if (activeSale && unitPrice !== round2(product.price)) {
        saleApplied = true;
        saleId = activeSale._id;
        saleName = activeSale.name;
      }

      normalizedProducts.push({
        productId: product._id,
        name: product.title,
        image: p.image || product.thumbnail || product.images?.[0] || "",
        quantity: qty,
        price: unitPrice,
        ...(p.selectedVariants ? { selectedVariants: String(p.selectedVariants) } : {}),
      });
    }

    const lineSubtotal = round2(
      normalizedProducts.reduce(
        (sum, p) => sum + round2(Number(p.price) * Number(p.quantity)),
        0
      )
    );

    // Validate coupon server-side.
    let discount = 0;
    let couponId = null;
    if (promoCode) {
      const couponResult = await applyCoupon(promoCode, lineSubtotal, authUserId);
      if (!couponResult.valid) {
        return abortWith(400, { message: couponResult.reason });
      }
      discount = couponResult.discount;
      couponId = couponResult.coupon._id;
    }

    // Sale pricing is already baked into normalizedProducts to match the cart.
    const saleDiscount = 0;

    // Membership discount placeholder.
    const membershipDiscount = 0;
    const totalDiscount = round2(discount + membershipDiscount);
    const taxableBase = round2(Math.max(0, lineSubtotal - totalDiscount));
    const tax = round2(taxableBase * INCLUDED_TAX_RATE);
    const effectiveShipping = taxableBase >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING_FEE;
    const grossTotal = round2(Math.max(0.01, taxableBase + effectiveShipping));

    const walletUsed = round2(Math.min(walletRequested, grossTotal));
    if (walletUsed > 0) {
      if ((user.walletBalance || 0) < walletUsed) {
        return abortWith(400, { message: "Insufficient wallet balance" });
      }
      user.walletBalance = round2(user.walletBalance - walletUsed);
      user.walletTransactions.push({
        type: "DEBIT",
        amount: walletUsed,
        reason: "Order payment",
      });
    }

    const netPayable = round2(Math.max(0, grossTotal - walletUsed));
    let paymentStatus = "PENDING";
    let paymentMethod = "COD";
    let paymentId;
    let paymentOrderId;

    if (netPayable > 0) {
      if (!paymentVerificationToken) {
        return abortWith(400, {
          message: "Payment verification token required for online payment",
        });
      }

      const verifiedPayment = await getCheckoutVerificationToken(paymentVerificationToken);
      if (!verifiedPayment) {
        return abortWith(400, { message: "Invalid or expired payment verification token" });
      }

      if (toIdString(verifiedPayment.userId) !== authUserId) {
        return abortWith(403, { message: "Payment verification does not belong to user" });
      }

      const duplicateOrder = await Order.findOne({
        $or: [
          { paymentId: verifiedPayment.paymentId },
          { paymentOrderId: verifiedPayment.paymentOrderId },
        ],
      })
        .select("_id orderId")
        .session(session);
      if (duplicateOrder) {
        return abortWith(409, {
          message: "Order already exists for this payment",
          orderId: duplicateOrder.orderId || String(duplicateOrder._id),
        });
      }

      const expectedPaise = Math.round(netPayable * 100);
      if (Math.abs((Number(verifiedPayment.amountPaise) || 0) - expectedPaise) > 1) {
        return abortWith(400, { message: "Payment amount mismatch" });
      }

      paymentStatus = "PAID";
      paymentMethod = "CARD";
      paymentId = verifiedPayment.paymentId;
      paymentOrderId = verifiedPayment.paymentOrderId;
      paymentTokenToConsume = paymentVerificationToken;
    } else {
      paymentStatus = "PAID";
      paymentMethod = "WALLET";
    }

    const newOrder = new Order({
      userId: user._id,
      customer: {
        name: user.name,
        email: user.email,
        phone: user.phone || "",
      },
      products: normalizedProducts,
      discount,
      saleDiscount,
      saleId: saleId || undefined,
      saleName: saleName || undefined,
      membershipDiscount,
      shipping: effectiveShipping,
      shippingAddress,
      promo: promoCode || undefined,
      couponId: couponId || undefined,
      paymentStatus,
      paymentMethod,
      paymentId,
      paymentOrderId,
      walletUsed,
    });

    await newOrder.save({ session });

    user.orders.push(newOrder._id);
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();

    if (paymentTokenToConsume) {
      consumeCheckoutVerificationToken(paymentTokenToConsume).catch((err) =>
        console.error("Payment token consume failed:", err)
      );
    }

    // Record coupon usage after successful commit.
    if (promoCode && couponId) {
      recordCouponUsage(promoCode, user._id).catch((err) =>
        console.error("Coupon usage tracking failed:", err)
      );
    }

    createNotification(
      "order",
      `New Order #${newOrder._id}`,
      `Order placed by ${user.name} for INR ${newOrder.totalPrice || "N/A"}.`,
      "/admin/orders"
    );

    if (user.email) {
      sendEmail({
        to: user.email,
        subject: "VKart Order Placed",
        html: emailTemplate({
          title: "Order placed successfully",
          body: `Your order ${newOrder.orderId || newOrder._id} has been placed successfully.`,
        }),
      }).catch((err) => console.error("Order email failed:", err));
    }

    return res.status(201).json(newOrder);
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error("Create order error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
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

/* ADMIN - GET ALL ORDERS */
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
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

/* ADMIN - UPDATE RETURN STATUS */
export const updateReturnStatus = async (req, res) => {
  const status = String(req.body.status || "").toUpperCase();
  const allowed = ["APPROVED", "PICKED", "RECEIVED", "REJECTED", "CLOSED"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: "Invalid return status" });
  }

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });

  order.returnStatus = status;
  order.returnHistory.push({ status });

  // Restore stock when return is received
  if (status === "RECEIVED") {
    for (const p of order.products) {
      if (p.productId) {
        await Product.findByIdAndUpdate(p.productId, { $inc: { stock: p.quantity } });
      }
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
  } else {
    order.refundStatus = "INITIATED";
    order.refundDueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await order.save();
  }

  createUserNotification(
    order.userId,
    "refund",
    "Refund initiated",
    `Your refund has been ${order.refundStatus === "COMPLETED" ? "completed" : "initiated"}.`,
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
        body: `Your refund has been ${order.refundStatus === "COMPLETED" ? "completed" : "initiated"}.`,
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
      const product = await Product.findById(p.productId).session(session);
      if (!product || !product.isActive) {
        await session.abortTransaction();
        return res.status(400).json({ message: "Product unavailable for replacement" });
      }
      if (product.stock < p.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ message: `Insufficient stock for ${product.title}` });
      }
      product.stock -= p.quantity;
      await product.save({ session });
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
    session.endSession();

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
    await session.abortTransaction();
    session.endSession();
    console.error("Replacement create error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* USER/ADMIN - DOWNLOAD INVOICE */
export const downloadInvoice = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    const isAdmin = Array.isArray(req.user?.roles) && req.user.roles.includes("admin");
    if (!isAdmin && String(order.userId) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Fetch store settings for branding
    const Settings = (await import("../models/Settings.js")).default;
    let settings = await Settings.findOne().lean();
    if (!settings) settings = {};

    const storeName = settings.storeName || "VKart";
    const tagline = settings.tagline || "Premium Lifestyle Store";
    const storeAddress = settings.address || "India";
    const supportEmail = settings.supportEmail || "";
    const supportPhone = settings.supportPhone || "";
    const gstNumber = settings.gstNumber || "";

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${order.invoiceNumber || order.orderId}.pdf`
    );
    doc.pipe(res);

    const inr = (n) => `₹${(Math.round(Number(n) || 0)).toLocaleString("en-IN")}`;
    const invoiceNo = order.invoiceNumber || order.orderId || String(order._id);
    const orderDate = new Date(order.createdAt || Date.now()).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });

    const pageW = doc.page.width;
    const marginL = 50;
    const marginR = 50;
    const contentW = pageW - marginL - marginR;

    /* ── HEADER BAR ── */
    doc.rect(0, 0, pageW, 80).fill("#111827");
    doc.fontSize(22).fillColor("#FFFFFF").text(storeName, marginL, 22);
    doc.fontSize(9).fillColor("#9CA3AF").text(tagline, marginL, 48);
    doc.fontSize(18).fillColor("#FFFFFF").text("TAX INVOICE", marginL + contentW - 120, 28, {
      width: 120, align: "right",
    });

    /* ── STORE + INVOICE META ── */
    let curY = 100;
    const colMid = marginL + contentW / 2;

    // Left: store info
    doc.fontSize(9).fillColor("#6B7280");
    if (storeAddress) { doc.text(storeAddress, marginL, curY, { width: contentW / 2 }); curY = doc.y; }
    if (supportEmail) { doc.text(supportEmail, marginL, curY); curY = doc.y; }
    if (supportPhone) { doc.text(supportPhone, marginL, curY); curY = doc.y; }
    if (gstNumber) { doc.text(`GSTIN: ${gstNumber}`, marginL, curY); curY = doc.y; }

    // Right: invoice meta
    const metaY = 100;
    doc.fontSize(9).fillColor("#374151");
    doc.text(`Invoice #:`, colMid, metaY, { width: 80, align: "right" });
    doc.font("Helvetica-Bold").text(invoiceNo, colMid + 85, metaY);
    doc.font("Helvetica").text("Order ID:", colMid, metaY + 14, { width: 80, align: "right" });
    doc.font("Helvetica-Bold").text(order.orderId || String(order._id), colMid + 85, metaY + 14);
    doc.font("Helvetica").text("Date:", colMid, metaY + 28, { width: 80, align: "right" });
    doc.text(orderDate, colMid + 85, metaY + 28);
    doc.font("Helvetica").text("Status:", colMid, metaY + 42, { width: 80, align: "right" });
    doc.text(order.paymentStatus || "PENDING", colMid + 85, metaY + 42);

    /* ── DIVIDER ── */
    curY = Math.max(curY, metaY + 60) + 12;
    doc.moveTo(marginL, curY).lineTo(marginL + contentW, curY).strokeColor("#E5E7EB").lineWidth(1).stroke();
    curY += 12;

    /* ── BILL TO / SHIP TO ── */
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text("BILL TO", marginL, curY);
    doc.font("Helvetica-Bold").text("SHIP TO", colMid, curY);
    curY += 14;
    doc.font("Helvetica").fontSize(9).fillColor("#374151");
    doc.text(order.customer?.name || "-", marginL, curY);
    doc.text(order.customer?.name || "-", colMid, curY);
    curY += 12;
    doc.text(order.customer?.email || "-", marginL, curY);
    curY += 12;
    if (order.customer?.phone) { doc.text(order.customer.phone, marginL, curY); curY += 12; }
    doc.text(order.shippingAddress || "-", colMid, curY - (order.customer?.phone ? 24 : 12), {
      width: contentW / 2 - 10,
    });
    curY += 8;

    /* ── DIVIDER ── */
    curY = Math.max(curY, doc.y) + 8;
    doc.moveTo(marginL, curY).lineTo(marginL + contentW, curY).strokeColor("#E5E7EB").lineWidth(1).stroke();
    curY += 4;

    /* ── ITEMS TABLE ── */
    const col = { item: marginL, qty: 310, price: 380, total: 460 };

    // Table header
    curY += 8;
    doc.rect(marginL, curY - 4, contentW, 18).fill("#F3F4F6");
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#374151");
    doc.text("ITEM", col.item + 4, curY, { width: 250 });
    doc.text("QTY", col.qty, curY, { width: 50, align: "center" });
    doc.text("PRICE", col.price, curY, { width: 70, align: "right" });
    doc.text("TOTAL", col.total, curY, { width: 80, align: "right" });
    curY += 20;

    // Table rows
    doc.font("Helvetica").fontSize(9).fillColor("#111827");
    const products = Array.isArray(order.products) ? order.products : [];
    products.forEach((p, idx) => {
      if (curY > 700) { doc.addPage(); curY = 50; }

      const lineTotal = Math.round(p.lineTotal || p.price * p.quantity);
      if (idx % 2 === 1) doc.rect(marginL, curY - 3, contentW, 18).fill("#F9FAFB");

      doc.fillColor("#111827").fontSize(9);
      const itemName = p.selectedVariants ? `${p.name || "-"} (${p.selectedVariants})` : (p.name || "-");
      doc.text(itemName, col.item + 4, curY, { width: 250, ellipsis: true });
      doc.text(String(p.quantity || 0), col.qty, curY, { width: 50, align: "center" });
      doc.text(inr(p.price), col.price, curY, { width: 70, align: "right" });
      doc.text(inr(lineTotal), col.total, curY, { width: 80, align: "right" });
      curY += 18;
    });

    // Table bottom line
    doc.moveTo(marginL, curY + 2).lineTo(marginL + contentW, curY + 2).strokeColor("#E5E7EB").lineWidth(1).stroke();
    curY += 14;

    /* ── PRICING SUMMARY ── */
    const sumX = col.price - 30;
    const valX = col.total;
    const sumW = 100;
    const valW = 80;

    const summaryLine = (label, value, opts = {}) => {
      if (curY > 740) { doc.addPage(); curY = 50; }
      const fontSize = opts.bold ? 10 : 9;
      const color = opts.color || (opts.bold ? "#111827" : "#374151");
      const fontName = opts.bold ? "Helvetica-Bold" : "Helvetica";
      doc.font(fontName).fontSize(fontSize).fillColor(color);
      doc.text(label, sumX, curY, { width: sumW, align: "right" });
      doc.text(value, valX, curY, { width: valW, align: "right" });
      curY += opts.bold ? 18 : 15;
    };

    summaryLine("Subtotal", inr(order.subtotal));

    // Discount breakdown
    if (order.discount > 0) {
      const couponLabel = order.promo ? `Coupon (${order.promo})` : "Coupon Discount";
      summaryLine(couponLabel, `- ${inr(order.discount)}`, { color: "#059669" });
    }
    if (order.saleDiscount > 0) {
      const saleLabel = order.saleName ? `Sale (${order.saleName})` : "Sale Discount";
      summaryLine(saleLabel, `- ${inr(order.saleDiscount)}`, { color: "#059669" });
    }
    if (order.membershipDiscount > 0) {
      summaryLine("Prime Discount", `- ${inr(order.membershipDiscount)}`, { color: "#7C3AED" });
    }

    summaryLine("Tax (18% GST)", inr(order.tax));
    summaryLine("Shipping", order.shipping > 0 ? inr(order.shipping) : "FREE", {
      color: order.shipping > 0 ? "#374151" : "#059669",
    });

    // Total separator
    doc.moveTo(sumX, curY - 4).lineTo(marginL + contentW, curY - 4).strokeColor("#D1D5DB").lineWidth(0.5).stroke();
    curY += 2;
    summaryLine("Total", inr(order.totalPrice), { bold: true });

    if (order.walletUsed > 0) {
      summaryLine("Wallet Used", `- ${inr(order.walletUsed)}`, { color: "#D97706" });
      const netPayable = Math.max(0, Math.round((order.totalPrice || 0) - (order.walletUsed || 0)));
      summaryLine("Net Payable", inr(netPayable), { bold: true });
    }

    /* ── PAYMENT INFO ── */
    curY += 8;
    if (curY > 700) { doc.addPage(); curY = 50; }
    doc.moveTo(marginL, curY).lineTo(marginL + contentW, curY).strokeColor("#E5E7EB").lineWidth(1).stroke();
    curY += 12;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text("PAYMENT DETAILS", marginL, curY);
    curY += 14;
    doc.font("Helvetica").fontSize(9).fillColor("#374151");
    doc.text(`Method: ${order.paymentMethod || "-"}`, marginL, curY);
    curY += 12;
    doc.text(`Status: ${order.paymentStatus || "PENDING"}`, marginL, curY);
    if (order.paymentId) {
      curY += 12;
      doc.text(`Transaction ID: ${order.paymentId}`, marginL, curY);
    }

    /* ── FOOTER ── */
    curY = Math.max(curY + 30, 720);
    if (curY > 770) { doc.addPage(); curY = 720; }
    doc.moveTo(marginL, curY).lineTo(marginL + contentW, curY).strokeColor("#E5E7EB").lineWidth(0.5).stroke();
    curY += 8;
    doc.font("Helvetica").fontSize(8).fillColor("#9CA3AF");
    doc.text("This is a computer-generated invoice and does not require a signature.", marginL, curY, {
      width: contentW, align: "center",
    });
    curY += 12;
    doc.text(`Thank you for shopping with ${storeName}!`, marginL, curY, {
      width: contentW, align: "center",
    });

    doc.end();
  } catch (err) {
    console.error("Invoice error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
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
      if (p.productId) {
        await Product.findByIdAndUpdate(p.productId, { $inc: { stock: p.quantity } }, { session });
      }
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
      } else {
        order.refundStatus = "INITIATED";
        order.refundDueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      }
    }

    await order.save({ session });
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    console.error("Cancel order error:", err);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    session.endSession();
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

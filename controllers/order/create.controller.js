import { validationResult } from "express-validator";
import mongoose from "mongoose";
import Order from "../../models/Order.js";
import User from "../../models/User.js";
import { createNotification } from "../admin.notifications.controller.js";
import { sendEmail, emailTemplate } from "../../services/email.service.js";
import { applyCoupon, recordCouponUsage } from "../coupon.controller.js";
import { getActiveSale } from "../sale.controller.js";
import {
  consumeCheckoutVerificationToken,
  getCheckoutVerificationToken,
} from "../../services/payment.session.service.js";
import { isCatalogLine, reserveLine } from "../../services/catalog.stock.js";
import { round2 } from "../../utils/calc.js";
import { toIdString } from "../../utils/helpers.js";

const TAX_RATE = 0.18;

const FREE_SHIPPING_THRESHOLD = 999;

const FLAT_SHIPPING_FEE = 50;

const INCLUDED_TAX_RATE = TAX_RATE / (1 + TAX_RATE);

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
    const isPrime = !!(user.membership?.endDate && new Date() < new Date(user.membership.endDate));

    // Inventory + canonical product prices come from DB.
    const normalizedProducts = [];
    let saleApplied = false;
    let saleId = null;
    let saleName = null;

    for (const p of products) {
      const qty = Math.max(1, Math.trunc(Number(p.quantity) || 0));

      // Only catalog lines can be ordered; anything else is a leftover from the retired catalog
      if (!isCatalogLine(p)) {
        return abortWith(400, {
          message: "An item in your cart is no longer sold. Please remove it and try again.",
        });
      }

      // Price and stock come from the variant, with the active sale applied
      try {
        const line = await reserveLine(
          { productId: p.productId, sku: p.sku, quantity: qty },
          session,
          { sale: activeSale, isPrime }
        );
        if (line.sale) {
          saleApplied = true;
          saleId = activeSale._id;
          saleName = activeSale.name;
        }
        const { sale: _sale, ...stored } = line;
        normalizedProducts.push(stored);
      } catch (err) {
        if (err.status === 400) return abortWith(400, { message: err.message });
        throw err;
      }
    }

    const lineSubtotal = round2(
      normalizedProducts.reduce((sum, p) => sum + round2(Number(p.price) * Number(p.quantity)), 0)
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
      // Razorpay's own reported method (upi/card/netbanking/wallet/paylater/
      // emi): bucket the ones we don't have a distinct enum value for
      // (wallet, emi) under CARD rather than losing the real method entirely.
      const rzpMethodMap = { upi: "UPI", netbanking: "NETBANKING", paylater: "PAYLATER" };
      paymentMethod = rzpMethodMap[verifiedPayment.method] || "CARD";
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

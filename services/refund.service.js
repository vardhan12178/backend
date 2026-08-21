import razorpay from "../utils/razorpay.js";

/**
 * Initiates a REAL Razorpay refund against a captured payment (instead of
 * the old placeholder that just set a 7-day due date and never touched the
 * gateway). Throws if the order has no paymentId to refund — callers should
 * catch that and fall back to the manual/placeholder path, which still
 * covers orders with no real gateway payment on record (legacy/COD data).
 */
export async function refundPaymentViaRazorpay(order, { reason } = {}) {
  if (!order.paymentId) {
    throw new Error("Order has no Razorpay paymentId to refund");
  }
  const amountPaise = Math.round((order.refundAmount || order.totalPrice || 0) * 100);
  const refund = await razorpay.payments.refund(order.paymentId, {
    amount: amountPaise,
    speed: "normal",
    notes: { orderId: order.orderId || String(order._id), reason: reason || "Order refund" },
  });
  return refund; // { id, status: "processed" | "pending", ... }
}

import cron from "node-cron";
import Order from "../models/Order.js";
import { createNotification } from "../controllers/admin.notifications.controller.js";

/*
 * Real refunds go through Razorpay at the moment they're initiated (see
 * services/refund.service.js) and are confirmed by the refund.processed
 * webhook. The only orders left INITIATED with a due date are ones with no
 * gateway payment on record (legacy/COD data), which no automated job can
 * actually pay back. This job used to flip those to COMPLETED and email the
 * customer anyway; now it flags them to the admins once, and the status stays
 * INITIATED until someone really refunds the customer.
 */
export async function flagDueManualRefunds(now = new Date()) {
  const due = await Order.find({
    refundStatus: "INITIATED",
    refundMethod: "ORIGINAL",
    refundDueAt: { $lte: now },
  });

  for (const order of due) {
    await createNotification(
      "refund",
      `Manual refund due for ${order.orderId || order._id}`,
      "No Razorpay payment is on record for this order, so it can't be refunded automatically. Refund it manually (for example to the customer's wallet).",
      `/admin/orders/${order._id}`
    );
    order.refundDueAt = undefined; // flag once
    await order.save();
  }
  return due.length;
}

export function initRefundScheduler() {
  cron.schedule("0 2 * * *", async () => {
    try {
      await flagDueManualRefunds();
    } catch (err) {
      console.error("Refund scheduler error:", err);
    }
  });
}

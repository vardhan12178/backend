import cron from "node-cron";
import Order from "../models/Order.js";
import { createUserNotification } from "../controllers/user.notifications.controller.js";
import { sendEmail, emailTemplate } from "./email.service.js";

export function initRefundScheduler() {
  cron.schedule("0 2 * * *", async () => {
    try {
      const now = new Date();
      const due = await Order.find({
        refundStatus: "INITIATED",
        refundMethod: "ORIGINAL",
        refundDueAt: { $lte: now },
      });

      for (const order of due) {
        order.refundStatus = "COMPLETED";
        order.returnStatus = "CLOSED";
        await order.save();

        createUserNotification(
          order.userId,
          "refund",
          "Refund completed",
          "Your refund to original payment method is completed.",
          `/orders/${order.orderId}`
        );

        if (order.customer?.email) {
          await sendEmail({
            to: order.customer.email,
            subject: "Refund completed",
            html: emailTemplate({
              title: "Refund completed",
              body: "Your refund to original payment method is completed.",
            }),
          });
        }
      }
    } catch (err) {
      console.error("Refund scheduler error:", err);
    }
  });
}

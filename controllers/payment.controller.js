import crypto from "crypto";
import {
    consumeCheckoutOrderSession,
    consumeWebhookConfirmation,
    getCheckoutOrderSession,
    getMembershipOrderSession,
    issueCheckoutVerificationToken,
    saveCheckoutOrderSession,
    saveWebhookConfirmation,
} from "../services/payment.session.service.js";
import razorpay from "../utils/razorpay.js";
import redis from "../utils/redis.js";
import Order from "../models/Order.js";
import { createNotification } from "./admin.notifications.controller.js";
import { createUserNotification } from "./user.notifications.controller.js";
import { sendEmail, emailTemplate } from "../services/email.service.js";
import { round2 } from "../utils/calc.js";
import { toIdString, secureEqual } from "../utils/helpers.js";

/* Create Order */
export const createOrder = async (req, res) => {
    try {
        const { amount, currency = "INR" } = req.body;
        const amountNum = Number(amount);

        if (!amountNum || amountNum <= 0) {
            return res.status(400).json({ success: false, message: "Amount is required" });
        }

        const normalizedAmount = Math.round(amountNum * 100);
        const receipt = `co_${String(req.user.userId).slice(-8)}_${Date.now()}`;

        const order = await razorpay.orders.create({
            amount: normalizedAmount,
            currency,
            receipt,
            payment_capture: 1,
        });

        await saveCheckoutOrderSession(order.id, {
            userId: toIdString(req.user.userId),
            amount: order.amount,
            currency: order.currency,
            receipt: order.receipt,
            createdAt: new Date().toISOString(),
        });

        res.json({
            success: true,
            orderId: order.id,
            currency: order.currency,
            amount: order.amount,
        });
    } catch (err) {
        console.error("Razorpay order error:", err);
        res.status(500).json({ success: false, message: "Failed to create Razorpay order" });
    }
};

/* Verify Payment */
export const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: "Missing payment fields" });
        }

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest("hex");

        if (!secureEqual(expectedSignature, razorpay_signature)) {
            return res.status(400).json({ success: false, message: "Invalid signature" });
        }

        let pending = await getCheckoutOrderSession(razorpay_order_id);

        // Fallback: the browser's own handler callback can miss (tab closed,
        // network drop right after a successful payment). If the webhook
        // already confirmed this same order independently, use that record
        // instead of failing outright — this is the whole point of running
        // a webhook alongside the client-driven flow.
        let viaWebhookFallback = false;
        if (!pending) {
            const webhookConfirmed = await consumeWebhookConfirmation(razorpay_order_id);
            if (webhookConfirmed) {
                pending = webhookConfirmed;
                viaWebhookFallback = true;
            }
        }

        if (!pending) {
            return res.status(400).json({ success: false, message: "Payment session expired or invalid" });
        }

        if (toIdString(pending.userId) !== toIdString(req.user.userId)) {
            return res.status(403).json({ success: false, message: "Payment session does not belong to user" });
        }

        // Reconcile with Razorpay source of truth.
        const [rzpOrder, rzpPayment] = await Promise.all([
            razorpay.orders.fetch(razorpay_order_id),
            razorpay.payments.fetch(razorpay_payment_id),
        ]);

        if (!rzpOrder || rzpOrder.id !== razorpay_order_id) {
            return res.status(400).json({ success: false, message: "Invalid Razorpay order" });
        }

        if (!rzpPayment || rzpPayment.order_id !== razorpay_order_id) {
            return res.status(400).json({ success: false, message: "Payment/order mismatch" });
        }

        const expectedPaise = Number(pending.amount) || 0;
        if ((rzpOrder.amount || 0) !== expectedPaise) {
            return res.status(400).json({ success: false, message: "Order amount mismatch" });
        }

        if ((rzpPayment.amount || 0) !== expectedPaise) {
            return res.status(400).json({ success: false, message: "Paid amount mismatch" });
        }

        if (String(rzpPayment.status || "").toLowerCase() !== "captured") {
            return res.status(400).json({ success: false, message: "Payment is not captured" });
        }

        await consumeCheckoutOrderSession(razorpay_order_id);

        const verificationToken = await issueCheckoutVerificationToken({
            userId: toIdString(req.user.userId),
            paymentId: razorpay_payment_id,
            paymentOrderId: razorpay_order_id,
            amountPaise: expectedPaise,
            amount: round2(expectedPaise / 100),
            currency: pending.currency || "INR",
            // Razorpay's own record of how this was actually paid (upi/card/
            // netbanking/wallet/emi) — lets the order carry the real method
            // instead of assuming CARD for every online payment.
            method: rzpPayment.method || null,
            verifiedAt: new Date().toISOString(),
        });

        return res.json({
            success: true,
            message: "Payment verified",
            verificationToken,
        });
    } catch (err) {
        console.error("Razorpay verify error:", err);
        res.status(500).json({ success: false, message: "Verification failed" });
    }
};

/* Razorpay Webhook — server-to-server confirmation, independent of the
   client's own handler callback. Razorpay retries on anything but a 2xx
   response, so once the signature checks out we always ack quickly and log
   problems rather than triggering a retry storm. */
export const handleWebhook = async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

        if (!signature || !secret || !req.rawBody) {
            return res.status(400).json({ success: false, message: "Missing signature" });
        }

        const expectedSignature = crypto
            .createHmac("sha256", secret)
            .update(req.rawBody)
            .digest("hex");

        if (!secureEqual(expectedSignature, signature)) {
            console.warn("Razorpay webhook: signature mismatch");
            return res.status(400).json({ success: false, message: "Invalid signature" });
        }

        const { event, payload } = req.body || {};
        const payment = payload?.payment?.entity;
        const refund = payload?.refund?.entity;
        const entityId = payment?.id || refund?.id;

        // Razorpay resends the identical payload on retry with no dedicated
        // event id of its own — dedupe on (event, entity id) for a window
        // comfortably longer than its retry schedule.
        if (event && entityId) {
            const seenKey = `webhook:seen:${event}:${entityId}`;
            const firstSeen = await redis.set(seenKey, "1", "EX", 24 * 60 * 60, "NX");
            if (firstSeen !== "OK") {
                return res.status(200).json({ received: true, duplicate: true });
            }
        }

        if (event === "payment.captured" && payment?.order_id) {
            // Read-only: never consumes the client's own checkout/membership
            // session, so this can't race a browser callback that fires
            // around the same moment. It only ever gets used as a fallback
            // in verifyPayment / verifyAndActivate. One Razorpay order can
            // only ever be either a checkout or a membership purchase, so
            // trying both lookups and taking whichever resolves is safe.
            const [checkoutPending, membershipPending] = await Promise.all([
                getCheckoutOrderSession(payment.order_id),
                getMembershipOrderSession(payment.order_id),
            ]);
            const pending = checkoutPending || membershipPending;
            await saveWebhookConfirmation(payment.order_id, {
                userId: pending?.userId || null,
                amount: payment.amount,
                currency: payment.currency || pending?.currency || "INR",
                paymentId: payment.id,
                receipt: pending?.receipt,
                planId: membershipPending?.planId,
                confirmedAt: new Date().toISOString(),
            });
            console.log(`Razorpay webhook: payment.captured for order ${payment.order_id} (${payment.id})`);
        } else if (event === "payment.failed" && payment?.order_id) {
            console.warn(
                `Razorpay webhook: payment.failed for order ${payment.order_id} — ${payment.error_description || "no reason given"}`
            );
        } else if (event === "refund.processed" && refund) {
            const order = await Order.findOne({
                $or: [{ refundId: refund.id }, { paymentId: refund.payment_id }],
            });
            if (order && order.refundStatus !== "COMPLETED") {
                order.refundStatus = "COMPLETED";
                order.refundId = order.refundId || refund.id;
                if (["REQUESTED", "APPROVED", "PICKED", "RECEIVED"].includes(order.returnStatus)) {
                    order.returnStatus = "CLOSED";
                }
                await order.save();

                createUserNotification(
                    order.userId,
                    "refund",
                    "Refund completed",
                    "Your refund to the original payment method is completed.",
                    `/orders/${order.orderId}`
                );
                if (order.customer?.email) {
                    await sendEmail({
                        to: order.customer.email,
                        subject: "Refund completed",
                        html: emailTemplate({
                            title: "Refund completed",
                            body: "Your refund to the original payment method is completed.",
                        }),
                    });
                }
                console.log(`Razorpay webhook: refund.processed for order ${order.orderId} (refund ${refund.id})`);
            }
        } else if (event === "refund.failed" && refund) {
            const order = await Order.findOne({
                $or: [{ refundId: refund.id }, { paymentId: refund.payment_id }],
            });
            if (order && order.refundStatus !== "FAILED") {
                order.refundStatus = "FAILED";
                order.refundId = order.refundId || refund.id;
                await order.save();

                createNotification(
                    "refund",
                    `Refund failed for ${order.orderId || order._id}`,
                    "Razorpay reported a failed refund — needs manual follow-up.",
                    "/admin/orders"
                );
                console.warn(`Razorpay webhook: refund.failed for order ${order.orderId} (refund ${refund.id})`);
            }
        }

        res.status(200).json({ received: true });
    } catch (err) {
        console.error("Razorpay webhook error:", err);
        // Already signature-verified at this point — ack anyway so Razorpay
        // doesn't hammer retries for an error that's now logged for follow-up.
        res.status(200).json({ received: true });
    }
};

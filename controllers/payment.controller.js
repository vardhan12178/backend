import Razorpay from "razorpay";
import crypto from "crypto";
import {
    consumeCheckoutOrderSession,
    getCheckoutOrderSession,
    issueCheckoutVerificationToken,
    saveCheckoutOrderSession,
} from "../services/payment.session.service.js";

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
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

const secureEqual = (a, b) => {
    const aBuf = Buffer.from(String(a || ""), "utf8");
    const bBuf = Buffer.from(String(b || ""), "utf8");
    return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
};

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

        const pending = await getCheckoutOrderSession(razorpay_order_id);
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

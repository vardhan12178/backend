import Razorpay from "razorpay";

// Single shared Razorpay client. Previously instantiated separately
// (identically) in payment.controller.js, membership.controller.js, and
// wallet.controller.js.
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export default razorpay;

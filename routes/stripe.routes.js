import express from "express";
import Stripe from "stripe";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Determine frontend URL based on environment
const isProd = process.env.NODE_ENV === "production";
const FRONTEND_URL = isProd ? process.env.APP_URL : "http://localhost:3000";

router.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: req.body.items,
      mode: "payment",
      success_url: `${FRONTEND_URL}/success`,
      cancel_url: `${FRONTEND_URL}/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout session error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

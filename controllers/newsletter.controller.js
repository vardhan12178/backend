import Newsletter from "../models/Newsletter.js";

/**
 * POST /api/newsletter/subscribe
 * Subscribe an email to the newsletter.
 */
export const subscribe = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    // Upsert — re-activate if previously unsubscribed
    await Newsletter.findOneAndUpdate(
      { email: email.toLowerCase().trim() },
      { email: email.toLowerCase().trim(), active: true, subscribedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: "Subscribed successfully!" });
  } catch (err) {
    // Duplicate key handled by upsert, but just in case
    if (err.code === 11000) {
      return res.json({ success: true, message: "Already subscribed!" });
    }
    console.error("Newsletter subscribe error:", err);
    res.status(500).json({ error: "Failed to subscribe" });
  }
};

/**
 * POST /api/newsletter/unsubscribe
 */
export const unsubscribe = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    await Newsletter.findOneAndUpdate(
      { email: email.toLowerCase().trim() },
      { active: false }
    );

    res.json({ success: true, message: "Unsubscribed" });
  } catch (err) {
    console.error("Newsletter unsubscribe error:", err);
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
};

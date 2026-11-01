import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { buildCookieOpts } from "../utils/cookies.js";
import { buildSessionPayload } from "./auth.controller.js";

// One-click demo logins for the portfolio: a shared shopper (can browse, add to cart, check out in Razorpay test
// mode) and a read-only admin. The accounts have random passwords nobody knows; the only way in is these endpoints,
// and tokens carry a `demo` claim that middleware/demoGuard.js uses to keep the admin read-only.
export const demoEnabled = () => String(process.env.DEMO_LOGINS ?? "true").toLowerCase() !== "false";

// Read access to the shop-facing admin modules. Customers, staff, support chats and settings stay private.
export const DEMO_ADMIN_PERMISSIONS = {
  products: "read",
  orders: "read",
  coupons: "read",
  sales: "read",
  membership: "read",
  reviews: "read",
  notifications: "read",
};

const ACCOUNTS = {
  shopper: { name: "Demo Shopper", username: "demo.shopper", email: "demo.shopper@vkart.demo" },
  admin: { name: "Demo Admin", username: "demo.admin", email: "demo.admin@vkart.demo" },
};

async function ensureAccount(kind) {
  const spec = ACCOUNTS[kind];
  const set = {
    name: spec.name,
    blocked: false,
    emailVerified: true,
    roles: kind === "admin" ? ["user", "admin"] : ["user"],
    adminRole: null,
    permissions: kind === "admin" ? DEMO_ADMIN_PERMISSIONS : {},
  };
  // Shoppers get a clean slate each time so the next visitor doesn't inherit someone else's bag
  if (kind === "shopper") Object.assign(set, { cart: [], wishlist: [] });

  const existing = await User.findOne({ username: spec.username }).select("_id");
  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: set });
    return existing._id;
  }
  const password = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  const created = await User.create({ ...spec, ...set, password });
  return created._id;
}

const guard = (req, res) => {
  if (demoEnabled()) return false;
  res.status(404).json({ message: "Demo logins are turned off" });
  return true;
};

export const demoShopper = async (req, res) => {
  try {
    if (guard(req, res)) return;
    const userId = await ensureAccount("shopper");
    const token = jwt.sign({ userId, roles: ["user"], demo: "shopper" }, process.env.JWT_SECRET, { expiresIn: "12h" });
    res.cookie("jwt_token", token, buildCookieOpts(req, false));
    res.json({ ...(await buildSessionPayload(userId)), token, demo: true });
  } catch (err) {
    console.error("Demo shopper login error:", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const demoAdmin = async (req, res) => {
  try {
    if (guard(req, res)) return;
    const userId = await ensureAccount("admin");
    const token = jwt.sign(
      { userId, roles: ["user", "admin"], adminRole: null, demo: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "4h" }
    );
    res.cookie("jwt_token", token, buildCookieOpts(req, false));
    res.json({ token, role: "admin", demo: true });
  } catch (err) {
    console.error("Demo admin login error:", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

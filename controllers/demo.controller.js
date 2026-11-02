import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Order from "../models/Order.js";
import CatalogProduct from "../models/CatalogProduct.js";
import CatalogReview from "../models/CatalogReview.js";
import { refreshRating } from "../services/catalog.userReviews.js";
import { buildCookieOpts } from "../utils/cookies.js";
import { buildSessionPayload } from "./auth.controller.js";

// One-click demo logins for the portfolio: a shared shopper (can browse, add to cart, check out in Razorpay test
// mode) and a read-only admin. The accounts have random passwords nobody knows; the only way in is these endpoints,
// and tokens carry a `demo` claim that middleware/demoGuard.js uses to keep the admin read-only.
export const demoEnabled = () =>
  String(process.env.DEMO_LOGINS ?? "true").toLowerCase() !== "false";

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

const DEMO_ORDER_ID = "VK-DEMO-DELIVERED";
const DAY = 86400000;

// Keeps the products of an existing demo order while they are still in the catalog, so reviews coming and
// going (which move a product's rating count) never swap them. Otherwise picks the two most-rated.
async function demoOrderLines() {
  const existing = await Order.collection.findOne(
    { orderId: DEMO_ORDER_ID },
    { projection: { products: 1 } }
  );
  const ids = (existing?.products || []).map((l) => l.productId);
  if (ids.length) {
    const found = await CatalogProduct.countDocuments({ _id: { $in: ids } });
    if (found === ids.length) return existing.products;
  }
  const picks = await CatalogProduct.find({
    status: { $in: ["active", "draft"] },
    "variants.0": { $exists: true },
  })
    .sort({ "rating.count": -1, slug: 1 })
    .limit(2)
    .select("title slug variants")
    .lean();
  return picks.map((p) => {
    const v = p.variants.find((x) => x.isDefault) || p.variants[0];
    return {
      productId: p._id,
      catalog: "v2",
      sku: v.sku,
      name: p.title,
      quantity: 1,
      price: v.price,
      lineTotal: v.price,
      selectedVariants: Object.entries(v.options || {})
        .map(([k, val]) => `${k}: ${val}`)
        .join(", "),
    };
  });
}

// Gives the demo shopper an already-delivered order for two popular products and clears any review a
// previous visitor wrote, so "Write a review" can be tried on those products. The order is flagged
// `isDemo`, which keeps it out of the admin order list and the dashboard figures.
export async function prepareDemoShopper(userId) {
  const stale = await CatalogReview.find({ userId }).select("productId").lean();
  if (stale.length) {
    await CatalogReview.deleteMany({ userId });
    const products = await CatalogProduct.find({ _id: { $in: stale.map((r) => r.productId) } })
      .select("slug priceRange")
      .lean();
    for (const p of products) await refreshRating(p);
  }
  const lines = await demoOrderLines();
  if (!lines.length) return;
  const total = lines.reduce((n, l) => n + l.price, 0);
  const placed = new Date(Date.now() - 12 * DAY);
  const history = [
    ["PLACED", 12],
    ["CONFIRMED", 12],
    ["PACKED", 11],
    ["SHIPPED", 10],
    ["OUT_FOR_DELIVERY", 8],
    ["DELIVERED", 8],
  ].map(([stage, ago]) => ({ stage, date: new Date(Date.now() - ago * DAY) }));

  await Order.collection.updateOne(
    { orderId: DEMO_ORDER_ID },
    {
      $set: {
        userId,
        products: lines,
        subtotal: total,
        totalPrice: total,
        stage: "DELIVERED",
        statusHistory: history,
        isDemo: true,
      },
      $setOnInsert: {
        orderId: DEMO_ORDER_ID,
        invoiceNumber: "VK-DEMO-INV",
        currency: "INR",
        paymentStatus: "PAID",
        paymentMethod: "UPI",
        customer: { name: ACCOUNTS.shopper.name, email: ACCOUNTS.shopper.email },
        shippingAddress: "221B Demo Street, Pune, Maharashtra 411001",
        returnStatus: "NONE",
        returnHistory: [],
        createdAt: placed,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  // Checkout links every order to the user's `orders` list, and the Orders page reads that list
  const saved = await Order.collection.findOne(
    { orderId: DEMO_ORDER_ID },
    { projection: { _id: 1 } }
  );
  await User.updateOne({ _id: userId }, { $addToSet: { orders: saved._id } });
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
    await prepareDemoShopper(userId);
    const token = jwt.sign({ userId, roles: ["user"], demo: "shopper" }, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });
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

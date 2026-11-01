import ProductAlert from "../models/ProductAlert.js";
import CatalogProduct from "../models/CatalogProduct.js";
import { createUserNotification } from "../controllers/user.notifications.controller.js";

// Price-drop and back-in-stock alerts. Shoppers ask from the product page; when an admin edit or a
// restocked order changes a variant, notifyVariantChange sends the notifications that now apply.

export const MAX_ALERTS_PER_USER = 50;
export class AlertError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const labelOf = (v) => Object.values(v?.options || {}).filter(Boolean).join(" · ");
const inr = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

export async function listAlerts(userId) {
  return ProductAlert.find({ userId }).sort({ createdAt: -1 }).lean();
}

/** Sets an alert. A price alert needs the variant to be in stock-agnostic; a stock alert only makes sense when it is out. */
export async function createAlert(userId, { productId, sku, kind }) {
  const product = await CatalogProduct.findOne({ _id: productId, status: { $in: ["active", "draft"] } })
    .select("slug title variants").lean();
  const variant = product?.variants.find((v) => v.sku === sku);
  if (!variant) throw new AlertError("Product not found", 404);
  if (kind === "stock" && (variant.stock || 0) > 0) throw new AlertError("This item is in stock right now");
  if ((await ProductAlert.countDocuments({ userId })) >= MAX_ALERTS_PER_USER) {
    throw new AlertError(`You can have up to ${MAX_ALERTS_PER_USER} alerts`);
  }
  const doc = {
    userId, productId, sku, kind, slug: product.slug, title: product.title, label: labelOf(variant),
    ...(kind === "price" ? { basePrice: variant.price } : {}),
  };
  try {
    await ProductAlert.updateOne({ userId, sku, kind }, { $set: doc }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  return ProductAlert.findOne({ userId, sku, kind }).lean();
}

export async function removeAlert(userId, id) {
  const { deletedCount } = await ProductAlert.deleteOne({ _id: id, userId });
  if (!deletedCount) throw new AlertError("Alert not found", 404);
}

/**
 * Sends the alerts a change makes true: price alerts when `after.price` is below the price the alert
 * was set at, stock alerts when the variant goes from out of stock to in stock. Returns how many were sent.
 */
export async function notifyVariantChange(productId, sku, before, after) {
  const jobs = [];
  if (after.price != null && before.price != null && after.price < before.price) {
    jobs.push(["price", { basePrice: { $gt: after.price } }]);
  }
  if ((before.stock || 0) <= 0 && (after.stock || 0) > 0) jobs.push(["stock", {}]);
  let sent = 0;
  for (const [kind, extra] of jobs) {
    const alerts = await ProductAlert.find({ productId, sku, kind, ...extra }).lean();
    for (const a of alerts) {
      const name = a.label ? `${a.title} (${a.label})` : a.title;
      await createUserNotification(
        a.userId, "alert",
        kind === "price" ? "Price drop" : "Back in stock",
        kind === "price" ? `${name} is now ${inr(after.price)}, down from ${inr(a.basePrice)}.` : `${name} is back in stock.`,
        `/products/${a.slug}?variant=${encodeURIComponent(sku)}`
      );
      await ProductAlert.deleteOne({ _id: a._id });
      sent += 1;
    }
  }
  return sent;
}

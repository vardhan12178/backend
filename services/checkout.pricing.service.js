import Product from "../models/Product.js";
import { applyCoupon } from "../controllers/coupon.controller.js";
import { getActiveSale, overlaySalePricing } from "../controllers/sale.controller.js";
import { round2 } from "../utils/calc.js";

export const TAX_RATE = 0.18;
export const FREE_SHIPPING_THRESHOLD = 999;
export const FLAT_SHIPPING_FEE = 50;
const INCLUDED_TAX_RATE = TAX_RATE / (1 + TAX_RATE);

/**
 * Server-side price of a cart: DB prices, active sale overlay, coupon,
 * shipping and wallet. Used both to create the Razorpay order (so the amount
 * the shopper pays is never taken from the client) and to place the order
 * itself, so the two can't disagree.
 *
 * Read-only: it checks stock but does not decrement it, and validates the
 * coupon without claiming a use. Pass `session` when called inside the order
 * transaction.
 *
 * Returns `{ error: { status, message } }` or the full quote.
 */
export async function quoteCheckout({ user, products, promoCode, walletRequested = 0, session = null }) {
  if (!Array.isArray(products) || products.length === 0) {
    return { error: { status: 400, message: "Cart is empty" } };
  }

  const activeSale = await getActiveSale();
  const isPrime = !!(user.membership?.endDate && new Date() < new Date(user.membership.endDate));

  const lines = [];
  const normalizedProducts = [];
  let saleId = null;
  let saleName = null;

  for (const p of products) {
    const qty = Math.max(1, Math.trunc(Number(p.quantity) || 0));
    const query = Product.findById(p.productId).select(
      "title thumbnail images category price discountPercentage stock isActive"
    );
    const product = await (session ? query.session(session) : query);

    if (!product || !product.isActive) {
      return { error: { status: 400, message: "Product unavailable" } };
    }
    if (product.stock < qty) {
      return { error: { status: 400, message: `Insufficient stock for ${product.title}` } };
    }

    const productSnapshot = {
      _id: product._id,
      title: product.title,
      thumbnail: product.thumbnail,
      images: product.images,
      category: product.category,
      price: product.price,
      discountPercentage: Number(product.discountPercentage) || 0,
    };

    const overlaidProduct = activeSale
      ? overlaySalePricing([productSnapshot], activeSale, isPrime)[0]
      : productSnapshot;

    const unitPrice = round2(overlaidProduct?.price ?? product.price);
    if (activeSale && unitPrice !== round2(product.price)) {
      saleId = activeSale._id;
      saleName = activeSale.name;
    }

    lines.push({ product, qty });
    normalizedProducts.push({
      productId: product._id,
      name: product.title,
      image: p.image || product.thumbnail || product.images?.[0] || "",
      quantity: qty,
      price: unitPrice,
      ...(p.selectedVariants ? { selectedVariants: String(p.selectedVariants) } : {}),
    });
  }

  const lineSubtotal = round2(
    normalizedProducts.reduce((sum, p) => sum + round2(Number(p.price) * Number(p.quantity)), 0)
  );

  let discount = 0;
  let couponId = null;
  if (promoCode) {
    const couponResult = await applyCoupon(promoCode, lineSubtotal, String(user._id));
    if (!couponResult.valid) {
      return { error: { status: 400, message: couponResult.reason } };
    }
    discount = couponResult.discount;
    couponId = couponResult.coupon._id;
  }

  // Sale pricing is already baked into normalizedProducts to match the cart.
  const saleDiscount = 0;
  // Membership discount placeholder.
  const membershipDiscount = 0;
  const totalDiscount = round2(discount + membershipDiscount);
  const taxableBase = round2(Math.max(0, lineSubtotal - totalDiscount));
  const tax = round2(taxableBase * INCLUDED_TAX_RATE);
  const shipping = taxableBase >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING_FEE;
  const grossTotal = round2(Math.max(0.01, taxableBase + shipping));

  const walletUsed = round2(Math.min(Math.max(0, Number(walletRequested) || 0), grossTotal));
  if (walletUsed > 0 && (user.walletBalance || 0) < walletUsed) {
    return { error: { status: 400, message: "Insufficient wallet balance" } };
  }

  const netPayable = round2(Math.max(0, grossTotal - walletUsed));

  return {
    lines,
    normalizedProducts,
    lineSubtotal,
    discount,
    couponId,
    saleDiscount,
    membershipDiscount,
    saleId,
    saleName,
    tax,
    shipping,
    grossTotal,
    walletUsed,
    netPayable,
  };
}

const lineKey = (productId, quantity, selectedVariants) =>
  `${String(productId)}|${Math.max(1, Math.trunc(Number(quantity) || 0))}|${selectedVariants ? String(selectedVariants) : ""}`;

const normPromo = (promo) => (typeof promo === "string" && promo.trim() ? promo.trim().toUpperCase() : null);

/**
 * The part of a quote worth remembering while the shopper is in the Razorpay
 * window: per-line prices and the totals they produced.
 */
export function snapshotQuote(quote, { promo = null, walletRequested = 0 } = {}) {
  return {
    lines: quote.normalizedProducts.map((p) => ({
      productId: String(p.productId),
      quantity: p.quantity,
      price: p.price,
      selectedVariants: p.selectedVariants || null,
    })),
    promo: normPromo(promo),
    walletRequested: round2(Math.max(0, Number(walletRequested) || 0)),
    discount: quote.discount,
    couponId: quote.couponId ? String(quote.couponId) : null,
    shipping: quote.shipping,
    tax: quote.tax,
    saleId: quote.saleId ? String(quote.saleId) : null,
    saleName: quote.saleName || null,
    walletUsed: quote.walletUsed,
    netPayable: quote.netPayable,
  };
}

/**
 * When the fresh price of a cart no longer matches what the shopper already
 * paid (a sale started/ended or a price was edited during payment), return a
 * quote that honours the prices from the snapshot taken when the Razorpay
 * order was created — but only if the cart, coupon and wallet request are
 * exactly what was quoted and the snapshot's total is what was paid.
 * Stock, availability and the coupon's limits are still checked fresh.
 * Returns null when the snapshot doesn't apply.
 */
export function honourQuotedPrices(freshQuote, snapshot, { products, promoCode, walletRequested, amountPaise }) {
  if (!snapshot?.lines?.length) return null;
  if (Math.round(Number(snapshot.netPayable) * 100) !== Number(amountPaise)) return null;
  if (normPromo(promoCode) !== snapshot.promo) return null;
  if (round2(Math.max(0, Number(walletRequested) || 0)) !== snapshot.walletRequested) return null;

  const requested = products.map((p) => lineKey(p.productId, p.quantity, p.selectedVariants)).sort();
  const quoted = snapshot.lines.map((l) => lineKey(l.productId, l.quantity, l.selectedVariants)).sort();
  if (requested.length !== quoted.length || requested.some((k, i) => k !== quoted[i])) return null;

  const quotedPrice = new Map(
    snapshot.lines.map((l) => [lineKey(l.productId, l.quantity, l.selectedVariants), l.price])
  );
  const normalizedProducts = freshQuote.normalizedProducts.map((p) => ({
    ...p,
    price: quotedPrice.get(lineKey(p.productId, p.quantity, p.selectedVariants)),
  }));
  const lineSubtotal = round2(normalizedProducts.reduce((sum, p) => sum + round2(p.price * p.quantity), 0));

  return {
    ...freshQuote,
    normalizedProducts,
    lineSubtotal,
    discount: snapshot.discount,
    couponId: snapshot.couponId || null,
    shipping: snapshot.shipping,
    tax: snapshot.tax,
    saleId: snapshot.saleId || null,
    saleName: snapshot.saleName || null,
    walletUsed: snapshot.walletUsed,
    netPayable: snapshot.netPayable,
    honoured: true,
  };
}

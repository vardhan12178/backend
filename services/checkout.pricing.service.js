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

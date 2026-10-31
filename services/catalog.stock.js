import CatalogProduct from "../models/CatalogProduct.js";
import { imagesFor, resolveImage, saleFor, salePrice } from "./catalog.service.js";

// Stock and pricing for catalog order lines (CATALOG_SCHEMA.md §9).
// A v2 line is { catalog: "v2", productId, sku, quantity }; price, title and image
// always come from the database, never from the client.

export class LineError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const isCatalogLine = (p) => p?.catalog === "v2";

export const variantLabel = (variant) => Object.values(variant?.options || {}).filter(Boolean).join(" · ");

function lineImage(product, variant) {
  const first = imagesFor(product, variant.options?.[product.media?.groupBy])[0];
  return resolveImage(first)?.md || "";
}

const SELLABLE = ["active", "draft"];

/**
 * Takes `qty` units of `sku` out of stock inside `session` and returns the priced line.
 * The decrement is a single conditional update, so two orders can't both take the last unit.
 */
export async function reserveLine({ productId, sku, quantity }, session, { sale = null, isPrime = false } = {}) {
  const qty = Math.max(1, Math.trunc(Number(quantity) || 0));
  if (!sku) throw new LineError("Missing variant for catalog item");

  const product = await CatalogProduct.findOneAndUpdate(
    { _id: productId, status: { $in: SELLABLE }, variants: { $elemMatch: { sku, stock: { $gte: qty } } } },
    { $inc: { "variants.$.stock": -qty } },
    { new: true, session, projection: { title: 1, media: 1, variants: 1, category: 1, categoryPath: 1, "keySpecs.gender": 1 } }
  ).lean();

  if (!product) {
    const exists = await CatalogProduct.findOne({ _id: productId, status: { $in: SELLABLE }, "variants.sku": sku })
      .select("title").session(session).lean();
    if (!exists) throw new LineError("Product unavailable");
    throw new LineError(`Insufficient stock for ${exists.title}`);
  }

  const variant = product.variants.find((v) => v.sku === sku);
  if (!product.variants.some((v) => v.stock > 0)) {
    await CatalogProduct.updateOne({ _id: product._id }, { $set: { inStock: false } }, { session });
  }

  const terms = saleFor(product, sale);
  const price = salePrice(variant, terms, isPrime);
  return {
    productId: product._id,
    catalog: "v2",
    sku,
    name: product.title,
    image: lineImage(product, variant),
    quantity: qty,
    price,
    selectedVariants: variantLabel(variant) || undefined,
    ...(price < variant.price ? { sale: { id: terms.id, name: terms.name } } : {}),
  };
}

/** Puts an order line's units back (cancellation, received return). */
export async function restoreLine(line, session) {
  if (!line?.productId || !line.sku) return;
  await CatalogProduct.updateOne(
    { _id: line.productId, "variants.sku": line.sku },
    { $inc: { "variants.$.stock": line.quantity }, $set: { inStock: true } },
    session ? { session } : undefined
  );
}

/**
 * Current price, stock and display fields for cart lines, so the cart never shows stale prices.
 * Input: [{ productId, sku, quantity }]. Unknown lines come back with available: false.
 */
export async function resolveCartLines(lines = [], { sale = null, isPrime = false } = {}) {
  const valid = lines.filter((l) => l && l.productId && l.sku && /^[a-f0-9]{24}$/i.test(String(l.productId))).slice(0, 100);
  const ids = [...new Set(valid.map((l) => String(l.productId)))];
  const products = await CatalogProduct.find({ _id: { $in: ids }, status: { $in: SELLABLE } })
    .select("slug title brand category categoryPath keySpecs.gender media variants").lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  return valid.map((l) => {
    const p = byId.get(String(l.productId));
    const v = p?.variants.find((x) => x.sku === l.sku);
    if (!p || !v) return { productId: String(l.productId), sku: l.sku, available: false };
    const qty = Math.max(1, Math.trunc(Number(l.quantity) || 1));
    const terms = saleFor(p, sale);
    const price = salePrice(v, terms, isPrime);
    return {
      productId: String(p._id),
      sku: v.sku,
      slug: p.slug,
      title: p.title,
      brand: p.brand,
      category: p.category,
      variantLabel: variantLabel(v),
      image: lineImage(p, v),
      price,
      mrp: v.mrp,
      discountPercent: v.mrp > price ? Math.round(((v.mrp - price) / v.mrp) * 100) : 0,
      sale: price < v.price ? terms.name : null,
      stock: v.stock ?? 0,
      quantity: qty,
      available: (v.stock ?? 0) >= qty,
    };
  });
}

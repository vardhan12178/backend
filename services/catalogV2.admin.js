import CatalogProduct from "../models/CatalogProduct.js";
import { CATEGORY_GROUPS, imagesFor, resolveImage, discountPercent } from "./catalogV2.service.js";

// Admin listing and edits for catalog v2: status, featured flag, and per-variant price, MRP and stock.
// Edits live in MongoDB; scripts/catalog-v2/import.js only rewrites a product when its data file changes.

export const STATUSES = ["active", "draft", "archived"];
export const LOW_STOCK = 5;
const PAGE_SIZE = 20;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const groupOf = (slug) => CATEGORY_GROUPS.find((g) => g.slug === slug);
const storefrontCategory = (p) => CATEGORY_GROUPS.find((g) => Object.entries(g.match).every(([k, v]) => {
  const actual = k.split(".").reduce((o, part) => (Array.isArray(o) ? o[Number(part)] : o?.[part]), p);
  return v && typeof v === "object" && "$ne" in v ? actual !== v.$ne : actual === v;
}))?.slug || p.category;

const STOCK_FILTERS = {
  out: { variants: { $elemMatch: { stock: { $lte: 0 } } } },
  low: { variants: { $elemMatch: { stock: { $gt: 0, $lte: LOW_STOCK } } } },
};

export function adminMatch({ q, category, status, stock } = {}) {
  const match = {};
  if (STATUSES.includes(status)) match.status = status;
  const group = category ? groupOf(String(category)) : null;
  if (group) Object.assign(match, group.match);
  if (STOCK_FILTERS[stock]) Object.assign(match, STOCK_FILTERS[stock]);
  const term = String(q || "").trim().slice(0, 80);
  if (term) {
    const re = { $regex: escapeRegex(term), $options: "i" };
    match.$or = [{ title: re }, { brand: re }, { slug: re }, { "variants.sku": re }];
  }
  return match;
}

export function toAdminRow(p) {
  const def = p.variants.find((v) => v.isDefault) || p.variants[0];
  const stock = p.variants.reduce((n, v) => n + Math.max(0, v.stock || 0), 0);
  return {
    id: String(p._id),
    slug: p.slug,
    title: p.title,
    brand: p.brand,
    category: storefrontCategory(p),
    status: p.status,
    isFeatured: Boolean(p.isFeatured),
    image: resolveImage(imagesFor(p, def?.options?.[p.media?.groupBy])[0]),
    priceRange: p.priceRange,
    rating: p.rating?.count ? p.rating : null,
    stock,
    lowStock: p.variants.some((v) => (v.stock || 0) > 0 && v.stock <= LOW_STOCK),
    outOfStock: p.variants.filter((v) => (v.stock || 0) <= 0).length,
    updatedAt: p.updatedAt,
    variants: p.variants.map((v) => ({
      sku: v.sku,
      label: Object.values(v.options || {}).filter(Boolean).join(" · ") || "Standard",
      price: v.price,
      mrp: v.mrp,
      stock: v.stock || 0,
      isDefault: Boolean(v.isDefault),
      discountPercent: discountPercent(v),
    })),
  };
}

export async function listAdminProducts(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || PAGE_SIZE));
  const match = adminMatch(query);
  const sort = query.sort === "title" ? { title: 1 } : query.sort === "stock" ? { inStock: 1, "priceRange.min": 1 } : { updatedAt: -1, _id: 1 };

  // Summary counts ignore the status/stock filters so the tabs always show their totals
  const scope = adminMatch({ q: query.q, category: query.category });
  const [docs, total, summary] = await Promise.all([
    CatalogProduct.find(match, { embedding: 0, searchText: 0, specs: 0, description: 0, source: 0, highlights: 0 })
      .sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    CatalogProduct.countDocuments(match),
    CatalogProduct.aggregate([
      { $match: scope },
      { $group: {
        _id: null,
        all: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
        draft: { $sum: { $cond: [{ $eq: ["$status", "draft"] }, 1, 0] } },
        archived: { $sum: { $cond: [{ $eq: ["$status", "archived"] }, 1, 0] } },
        out: { $sum: { $cond: [{ $anyElementTrue: [{ $map: { input: "$variants", as: "v", in: { $lte: ["$$v.stock", 0] } } }] }, 1, 0] } },
        low: { $sum: { $cond: [{ $anyElementTrue: [{ $map: { input: "$variants", as: "v", in: { $and: [{ $gt: ["$$v.stock", 0] }, { $lte: ["$$v.stock", LOW_STOCK] }] } } }] }, 1, 0] } },
      } },
    ]),
  ]);
  const { _id, ...counts } = summary[0] || { all: 0, active: 0, draft: 0, archived: 0, out: 0, low: 0 };
  return { products: docs.map(toAdminRow), total, page, pages: Math.max(1, Math.ceil(total / limit)), counts };
}

export class AdminEditError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function updateProductMeta(id, { status, isFeatured }) {
  const set = {};
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new AdminEditError("Unknown status");
    set.status = status;
  }
  if (isFeatured !== undefined) set.isFeatured = Boolean(isFeatured);
  if (!Object.keys(set).length) throw new AdminEditError("Nothing to update");
  const p = await CatalogProduct.findByIdAndUpdate(id, { $set: set }, { new: true, projection: { embedding: 0 } }).lean();
  if (!p) throw new AdminEditError("Product not found", 404);
  return toAdminRow(p);
}

/** Sets the status of several products at once; ids may be "all" with a filter instead. */
export async function bulkSetStatus({ ids, filter, status }) {
  if (!STATUSES.includes(status)) throw new AdminEditError("Unknown status");
  const match = ids === "all" ? adminMatch(filter || {}) : { _id: { $in: Array.isArray(ids) ? ids : [] } };
  if (ids !== "all" && !match._id.$in.length) throw new AdminEditError("Select at least one product");
  const { modifiedCount, matchedCount } = await CatalogProduct.updateMany(match, { $set: { status } });
  return { matched: matchedCount, updated: modifiedCount, status };
}

/** Sets price, MRP and/or stock on one variant, keeping priceRange and inStock in step. */
export async function updateVariant(id, sku, { price, mrp, stock }) {
  const p = await CatalogProduct.findById(id, { embedding: 0 });
  if (!p) throw new AdminEditError("Product not found", 404);
  const v = p.variants.find((x) => x.sku === sku);
  if (!v) throw new AdminEditError("Variant not found", 404);

  const nextPrice = price ?? v.price;
  const nextMrp = mrp ?? v.mrp;
  if (!(nextPrice > 0)) throw new AdminEditError("Price must be more than zero");
  if (nextMrp < nextPrice) throw new AdminEditError("MRP can't be lower than the selling price");
  if (stock !== undefined && !(stock >= 0)) throw new AdminEditError("Stock can't be negative");

  if (price !== undefined) v.price = price;
  if (mrp !== undefined) v.mrp = mrp;
  if (stock !== undefined) v.stock = stock;
  const prices = p.variants.map((x) => x.price);
  p.priceRange = { min: Math.min(...prices), max: Math.max(...prices) };
  p.inStock = p.variants.some((x) => (x.stock || 0) > 0);
  await p.save();
  return toAdminRow(p.toObject());
}

import CatalogProduct from "../models/CatalogProduct.js";
import { ratingFor, reviewsFor } from "./catalogV2.reviews.js";

// Read side of the catalog v2 API (CATALOG_V2_SCHEMA.md §8).
// Controllers stay thin; everything that shapes queries or responses lives here.

const BUCKET = process.env.S3_BUCKET || "vkart-assets-mumbai";
const REGION = process.env.S3_REGION || "ap-south-1";
const IMAGE_BASE = (process.env.S3_PUBLIC_BASE_URL || `https://${BUCKET}.s3.${REGION}.amazonaws.com`).replace(/\/$/, "") + "/catalog-v2";

// Until launch every imported product is "draft"; set CATALOG_V2_ACTIVE_ONLY=true to hide drafts.
export const visibleStatuses = () => (process.env.CATALOG_V2_ACTIVE_ONLY === "true" ? ["active"] : ["active", "draft"]);

export const PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

/* ------------ Storefront categories ------------
 * The shop groups some stored categories differently from how they are stored:
 * fashion is split by gender and the three large appliances share one tab.
 */
export const CATEGORY_GROUPS = [
  { slug: "mobiles", name: "Mobiles", match: { category: "mobiles" } },
  { slug: "laptops", name: "Laptops", match: { category: "laptops" } },
  { slug: "tablets", name: "Tablets", match: { category: "tablets" } },
  { slug: "tvs", name: "TVs", match: { category: "tvs" } },
  { slug: "monitors", name: "Monitors", match: { category: "monitors" } },
  { slug: "audio", name: "Audio", match: { category: "audio" } },
  { slug: "wearables", name: "Watches", match: { category: "wearables" } },
  { slug: "skincare", name: "Skincare", match: { category: "skincare" } },
  { slug: "fashion-men", name: "Men's Fashion", match: { category: "fashion", "keySpecs.gender": { $ne: "Women" } } },
  { slug: "fashion-women", name: "Women's Fashion", match: { category: "fashion", "keySpecs.gender": "Women" } },
  { slug: "appliances", name: "Appliances", match: { "categoryPath.0": "home-appliances" } },
  { slug: "kitchen-appliances", name: "Kitchen", match: { category: "kitchen-appliances" } },
  { slug: "grooming", name: "Grooming", match: { category: "grooming" } },
  { slug: "sports", name: "Sports", match: { category: "sports" } },
];
const GROUP_BY_SLUG = new Map(CATEGORY_GROUPS.map((g) => [g.slug, g]));

/* ------------ Response shaping ------------ */
export function resolveImage(item) {
  if (!item) return null;
  if (item.key) {
    const base = `${IMAGE_BASE}/${item.key}`;
    return { alt: item.alt, thumb: `${base}-thumb.webp`, md: `${base}-md.webp`, lg: `${base}-lg.webp`, width: item.width, height: item.height };
  }
  // Not uploaded yet: fall back to the brand's own URL for every size
  return { alt: item.alt, thumb: item.src, md: item.src, lg: item.src };
}

export const discountPercent = (v) => (v && v.mrp > v.price ? Math.round(((v.mrp - v.price) / v.mrp) * 100) : 0);

const defaultVariantOf = (p) => p.variants.find((v) => v.isDefault) || p.variants[0];

export function imagesFor(p, optionValue) {
  const media = p.media || {};
  return [...((media.groups || {})[optionValue] || []), ...(media.common || [])];
}

export function toCard(p) {
  const v = defaultVariantOf(p);
  const first = imagesFor(p, v?.options?.[p.media?.groupBy])[0];
  const colors = (p.variantOptions || []).find((o) => o.name === "Color")?.values || [];
  return {
    id: String(p._id),
    sku: v?.sku,
    slug: p.slug,
    title: p.title,
    brand: p.brand,
    category: p.category,
    image: resolveImage(first),
    price: v?.price,
    mrp: v?.mrp,
    discountPercent: discountPercent(v),
    priceRange: p.priceRange,
    colors: colors.map((c) => ({ value: c.value, hex: c.hex })),
    variantCount: p.variants.length,
    // Default variant's options, so listing tiles can add it to the cart directly
    options: v?.options || {},
    defaultInStock: Boolean(v && (v.stock == null || v.stock > 0) && v.keySpecs?.available !== false),
    rating: ratingFor(p),
    // Clothing with several sizes: tiles ask for a size instead of guessing one
    needsSize: ((p.variantOptions || []).find((o) => o.name === "Size")?.values.length || 0) > 1,
    inStock: p.inStock,
    launchDate: p.launchDate,
  };
}

export function toDetail(p) {
  const media = p.media || {};
  const resolveList = (list) => (list || []).map(resolveImage);
  return {
    ...p,
    _id: undefined,
    __v: undefined,
    embedding: undefined,
    contentHash: undefined,
    media: {
      groupBy: media.groupBy,
      groups: Object.fromEntries(Object.entries(media.groups || {}).map(([k, list]) => [k, resolveList(list)])),
      common: resolveList(media.common),
    },
    variants: p.variants.map((v) => ({ ...v, discountPercent: discountPercent(v), inStock: (v.stock ?? 0) > 0 })),
    id: String(p._id),
    rating: ratingFor(p) || (p.rating?.count ? p.rating : null),
    reviews: reviewsFor(p),
  };
}

/* ------------ Listing ------------ */
const SORTS = {
  featured: { isFeatured: -1, "priceRange.min": -1, _id: 1 },
  "price-asc": { "priceRange.min": 1, _id: 1 },
  "price-desc": { "priceRange.min": -1, _id: 1 },
  discount: { discountPercent: -1, "priceRange.min": -1, _id: 1 },
  newest: { launchDate: -1, _id: 1 },
  // Keyword search: best text match first (only meaningful with q; otherwise treated as featured)
  relevance: { _score: -1, isFeatured: -1, _id: 1 },
};
export const SORT_KEYS = Object.keys(SORTS);

const toList = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((s) => s.trim()).filter(Boolean);
const toNumber = (v) => (v === undefined || v === "" || v === null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Builds the base $match from query params (everything except brand, so brand facets stay complete). */
export function buildMatch(query = {}) {
  const match = { status: { $in: visibleStatuses() } };
  const group = query.category ? GROUP_BY_SLUG.get(String(query.category)) : null;
  if (group) Object.assign(match, group.match);
  else if (query.category) match.category = String(query.category);

  const min = toNumber(query.minPrice);
  const max = toNumber(query.maxPrice);
  if (min !== null || max !== null) {
    match["priceRange.min"] = {};
    if (min !== null) match["priceRange.min"].$gte = min;
    if (max !== null) match["priceRange.min"].$lte = max;
  }
  if (query.inStock === "true" || query.inStock === true) match.inStock = true;
  if (query.q && String(query.q).trim().length >= 2) match.$text = { $search: String(query.q).trim().slice(0, 100) };
  return match;
}

export async function listProducts(query = {}) {
  const page = Math.max(1, Math.floor(toNumber(query.page) || 1));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(toNumber(query.limit) || PAGE_SIZE)));
  const searching = Boolean(buildMatch(query).$text);
  const requested = SORTS[query.sort] ? query.sort : searching ? "relevance" : "featured";
  const sortKey = requested === "relevance" && !searching ? "featured" : requested;
  const brands = toList(query.brand);
  const minDiscount = toNumber(query.minDiscount);

  const addDiscount = {
    $addFields: {
      _default: { $ifNull: [{ $first: { $filter: { input: "$variants", cond: "$$this.isDefault" } } }, { $first: "$variants" }] },
    },
  };
  const computeDiscount = {
    $addFields: {
      discountPercent: {
        $cond: [{ $gt: ["$_default.mrp", "$_default.price"] },
          { $round: [{ $multiply: [{ $divide: [{ $subtract: ["$_default.mrp", "$_default.price"] }, "$_default.mrp"] }, 100] }, 0] }, 0],
      },
    },
  };
  const narrow = [];
  if (brands.length) narrow.push({ $match: { brand: { $in: brands } } });
  if (minDiscount) narrow.push({ $match: { discountPercent: { $gte: minDiscount } } });

  const [result] = await CatalogProduct.aggregate([
    { $match: buildMatch(query) },
    ...(searching ? [{ $addFields: { _score: { $meta: "textScore" } } }] : []),
    { $project: { embedding: 0, searchText: 0, specs: 0, description: 0, source: 0 } },
    addDiscount,
    computeDiscount,
    {
      $facet: {
        brands: [...(minDiscount ? [{ $match: { discountPercent: { $gte: minDiscount } } }] : []), { $group: { _id: "$brand", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
        priceBounds: [{ $group: { _id: null, min: { $min: "$priceRange.min" }, max: { $max: "$priceRange.min" } } }],
        total: [...narrow, { $count: "n" }],
        items: [...narrow, { $sort: SORTS[sortKey] }, { $skip: (page - 1) * limit }, { $limit: limit }],
      },
    },
  ]);

  const total = result.total[0]?.n || 0;
  return {
    products: result.items.map(toCard),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    sort: sortKey,
    facets: {
      brands: result.brands.map((b) => ({ name: b._id, count: b.count })),
      price: result.priceBounds[0] ? { min: result.priceBounds[0].min, max: result.priceBounds[0].max } : null,
    },
  };
}

/* ------------ Categories ------------ */
export async function getCategories() {
  const statuses = visibleStatuses();
  const counts = await Promise.all(
    CATEGORY_GROUPS.map((g) => CatalogProduct.countDocuments({ status: { $in: statuses }, ...g.match }))
  );
  return CATEGORY_GROUPS.map((g, i) => ({ slug: g.slug, name: g.name, count: counts[i] })).filter((c) => c.count > 0);
}

/* ------------ Detail ------------ */
export async function getProduct(slug) {
  const p = await CatalogProduct.findOne({ slug: String(slug), status: { $in: visibleStatuses() } }).lean();
  return p ? toDetail(p) : null;
}

/* ------------ Similar ------------
 * Vector search on the product's own embedding (Atlas index `catalog_v2_vector`),
 * limited to the same storefront category. Falls back to same category, closest price,
 * when the index or embedding is missing.
 */
export async function getSimilar(slug, { limit = 12 } = {}) {
  const safeLimit = Math.min(24, Math.max(1, Number(limit) || 12));
  const p = await CatalogProduct.findOne({ slug: String(slug) }).select("+embedding").lean();
  if (!p) return null;

  const group = CATEGORY_GROUPS.find((g) => Object.entries(g.match).every(([k, v]) => {
    const actual = k.split(".").reduce((o, part) => (o == null ? o : o[part]), p);
    return v && typeof v === "object" && "$ne" in v ? actual !== v.$ne : actual === v;
  }));
  const sameGroup = group ? group.match : { category: p.category };
  const statuses = visibleStatuses();

  if (Array.isArray(p.embedding) && p.embedding.length) {
    try {
      const hits = await CatalogProduct.aggregate([
        {
          $vectorSearch: {
            index: process.env.CATALOG_V2_VECTOR_INDEX || "catalog_v2_vector",
            path: "embedding",
            queryVector: p.embedding,
            numCandidates: safeLimit * 15,
            limit: safeLimit * 3,
            filter: { category: p.category, status: { $in: statuses } },
          },
        },
        { $match: { slug: { $ne: p.slug }, ...sameGroup } },
        { $limit: safeLimit },
        { $project: { embedding: 0, searchText: 0, specs: 0, description: 0, source: 0 } },
      ]);
      if (hits.length) return { source: "vector", products: hits.map(toCard) };
    } catch {
      // Index not created yet (or not on Atlas): use the price fallback below
    }
  }

  const price = p.priceRange?.min || 0;
  const near = await CatalogProduct.aggregate([
    { $match: { slug: { $ne: p.slug }, status: { $in: statuses }, ...sameGroup } },
    { $addFields: { _gap: { $abs: { $subtract: ["$priceRange.min", price] } } } },
    { $sort: { _gap: 1, _id: 1 } },
    { $limit: safeLimit },
    { $project: { embedding: 0, searchText: 0, specs: 0, description: 0, source: 0 } },
  ]);
  return { source: "price", products: near.map(toCard) };
}

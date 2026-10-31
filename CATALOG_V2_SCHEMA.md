# Catalog v2 — Schema Design

Status: **Draft for review.** Nothing is built yet.

Goal: a modern product catalog that works like a real Indian e-commerce site. It has real variants (storage × color), full spec sheets, multiple HD images per color and correct prices. It is also designed so the AI assistant (see `AI_UPGRADE_PLAN.md`) can filter and answer accurately.

The current `Product` model stays untouched and keeps serving the live site. v2 lives in **new collections** behind **new `/api/v2` routes** until it's complete. Then we switch over and retire v1.

---

## 1. Collections

| Collection | Purpose |
|---|---|
| `categories` | Category tree + the **spec template** for each category (which specs and filters it uses) |
| `catalog_products` | One document per product model (e.g. "iPhone 17 Pro"), with its **variants embedded** |
| `product_reviews` | Reviews in their own collection (product docs stay small, and reviews can be paged and searched) |

**Why variants are embedded, not a separate collection:** a phone has 4–12 variants and they're always read together with the product. One document means one read, atomic updates and simple code. At our scale (a few thousand products) this is the standard choice.

---

## 2. `categories`

```js
{
  _id, slug: "mobiles", name: "Mobiles",
  parent: "electronics",              // slug of parent, null for top level
  path: ["electronics", "mobiles"],   // for breadcrumbs and "all electronics" queries
  image, sortOrder, isActive,

  // Which option names variants in this category use
  variantOptions: ["Storage", "Color"],          // laptops: ["Configuration", "Color"], shirts: ["Size", "Color"]

  // Spec sheet template: groups → fields. Drives the product form, the spec table and validation.
  specTemplate: [
    { group: "Display", fields: [
      { key: "size",        label: "Screen Size",  unit: "inch", type: "number" },
      { key: "type",        label: "Display Type", type: "string" },
      { key: "resolution",  label: "Resolution",   type: "string" },
      { key: "refreshRate", label: "Refresh Rate", unit: "Hz", type: "number" },
      { key: "peakBrightness", label: "Peak Brightness", unit: "nits", type: "number" }
    ]},
    { group: "Performance", fields: [ /* chip, cpu, gpu, ram options */ ] },
    { group: "Camera",      fields: [ /* rear setup, main MP, front MP, video */ ] },
    { group: "Battery",     fields: [ /* capacity, wired W, wireless W */ ] },
    { group: "Connectivity",fields: [ /* 5G, Wi-Fi, BT, NFC, eSIM, USB */ ] },
    { group: "Build",       fields: [ /* dimensions, weight, materials, IP rating */ ] },
    { group: "Software",    fields: [ /* OS, update policy */ ] }
  ],

  // Numeric/boolean specs pulled out for filters and the AI. Keys map into product.keySpecs.
  filters: [
    { key: "price",        label: "Price",    type: "range" },
    { key: "brand",        label: "Brand",    type: "multi" },
    { key: "ramGB",        label: "RAM",      type: "multi", unit: "GB" },
    { key: "storageGB",    label: "Storage",  type: "multi", unit: "GB" },
    { key: "batteryMah",   label: "Battery",  type: "range", unit: "mAh" },
    { key: "displayInch",  label: "Screen",   type: "range", unit: "inch" },
    { key: "mainCameraMP", label: "Camera",   type: "range", unit: "MP" },
    { key: "is5G",         label: "5G",       type: "bool" }
  ]
}
```

The same model covers laptops (Processor, RAM, SSD, GPU, Display), skincare (Skin type, Concern, Key ingredients, Size ml) and fashion (Fabric, Fit, Sleeve, Occasion). Each category only needs a new template; no new code.

---

## 3. `catalog_products`

### Example (trimmed)

The values below only show the shape. Real data comes from official spec pages during collection.

```js
{
  _id,
  slug: "apple-iphone-17-pro",
  title: "Apple iPhone 17 Pro",
  brand: "Apple",
  category: "mobiles",
  categoryPath: ["electronics", "mobiles"],
  status: "active",                     // draft | active | archived
  launchDate: "2025-09-19",

  shortDescription: "Pro cameras, A19 Pro chip and an aluminium unibody design.",
  description: "…2–4 paragraphs written for shoppers…",
  highlights: [
    "6.3-inch Super Retina XDR display with ProMotion up to 120Hz",
    "A19 Pro chip",
    "48MP Pro Fusion camera system",
    "…"
  ],

  // Full spec sheet, shaped by the category's specTemplate
  specs: {
    Display:     { size: 6.3, type: "Super Retina XDR OLED", resolution: "2622 × 1206", refreshRate: 120 },
    Performance: { chip: "A19 Pro" },
    Camera:      { rear: "48MP Main + 48MP Ultra Wide + 48MP Telephoto", front: "18MP" },
    Battery:     { videoPlaybackHours: 31 },
    Connectivity:{ fiveG: true, eSIM: true, usb: "USB-C (USB 3)" },
    Build:       { weightG: 204, ipRating: "IP68" },
    Software:    { os: "iOS 26" }
  },

  // Flat numbers/booleans for filtering, sorting and AI pre-filters.
  // Variant-dependent values (storage) live on the variant; these are product-level.
  keySpecs: { ramGB: 12, displayInch: 6.3, mainCameraMP: 48, refreshRateHz: 120, is5G: true, batteryMah: null },

  // Which choices exist, in display order. Colors carry a swatch.
  variantOptions: [
    { name: "Storage", values: [{ value: "256GB" }, { value: "512GB" }, { value: "1TB" }] },
    { name: "Color",   values: [{ value: "Cosmic Orange", hex: "#F77E2D" }, { value: "Deep Blue", hex: "#2E3A59" }, { value: "Silver", hex: "#E3E4E5" }] }
  ],

  // Images grouped once per color, so 256GB / 512GB / 1TB share them instead of duplicating.
  media: {
    groupBy: "Color",
    groups: {
      "Cosmic Orange": [ { key: "mobiles/apple-iphone-17-pro/cosmic-orange-1", alt: "iPhone 17 Pro in Cosmic Orange, back view" }, … ],
      "Deep Blue":     [ … ],
      "Silver":        [ … ]
    },
    common: [ /* images that aren't color-specific, e.g. camera close-up, lifestyle */ ]
  },

  variants: [
    {
      sku: "APL-IP17P-256-ORG",
      options: { Storage: "256GB", Color: "Cosmic Orange" },
      price: 134900,          // selling price (₹, integer rupees)
      mrp: 134900,            // printed price; discount % is derived, never stored
      stock: 25,
      isDefault: true,
      keySpecs: { storageGB: 256 }
    },
    { sku: "APL-IP17P-512-ORG", options: { Storage: "512GB", Color: "Cosmic Orange" }, price: 154900, mrp: 154900, stock: 10, keySpecs: { storageGB: 512 } },
    …
  ],

  // Denormalized from variants on every save, for list pages and filters
  priceRange: { min: 134900, max: 174900 },
  inStock: true,

  inTheBox: ["iPhone with iOS 26", "USB-C Charge Cable (1 m)", "Documentation"],
  warranty: "1 year manufacturer warranty",
  returnPolicy: "7 days replacement",

  // Ratings summary, kept in sync from product_reviews
  rating: { average: 4.6, count: 128, distribution: { 5: 90, 4: 25, 3: 8, 2: 3, 1: 2 } },

  // AI
  useCases: ["camera", "video", "performance", "premium"],   // generated by Gemini, reviewed by a human
  searchText: "…generated summary used for the embedding (see §6)…",
  embedding: [ /* 768 floats */ ],                           // select: false
  embeddingUpdatedAt,

  // Provenance — where the data and images came from, for refreshing and attribution
  source: { urls: ["https://www.apple.com/in/iphone-17-pro/specs/"], fetchedAt, notes },

  seo: { metaTitle, metaDescription },
  isFeatured: false,
  createdAt, updatedAt
}
```

### Rules

- **Money:** integer rupees (`134900`), no floats. `discountPercent = round((mrp - price) / mrp * 100)`, computed in the API response, never stored.
- **SKU:** unique across all products (unique index on `variants.sku`). Pattern is `BRAND-MODEL-STORAGE-COLOR`, uppercase.
- **Exactly one `isDefault` variant** per product. It's what list pages show and what the product page opens on.
- **Every variant's `options`** must use the names in `variantOptions` and only the listed values. Validated on save.
- **Every color in `variantOptions`** must have a `media.groups` entry with at least 3 images.
- **`priceRange` and `inStock`** are recomputed in a pre-save hook. Never set them by hand.
- **Sales** (existing `Sale` model) apply on top of `variant.price` by category, the same as today. The API returns `price`, `mrp`, `salePrice?` and `discountPercent`.

---

## 4. `product_reviews`

```js
{ _id, productId, sku?, userId?, authorName, rating: 1-5, title, body, images: [],
  verifiedPurchase: false, helpfulCount: 0, status: "published", createdAt }
```

- Index: `{ productId: 1, createdAt: -1 }`, `{ productId: 1, rating: -1 }`.
- The product's `rating` summary is updated when a review is added or removed.
- Seeded demo reviews are marked `seeded: true`, so they can be removed or excluded later.
- The AI "review Q&A" tool (AI plan, tool D) searches this collection by `productId`.

---

## 5. Images

**Source:** official brand product pages (Apple, Samsung, OnePlus, Vivo, Oppo, Xiaomi, Nothing, Google). Motorola is skipped for now because its site refuses automated requests.

**Pipeline (import script):**
1. Download each source image once (record the source URL in `source.urls`).
2. Reject anything under 1000 px on the long edge.
3. Convert to WebP with `sharp` in three sizes:
   - `thumb` 300 px (list cards, cart)
   - `md` 800 px (product page)
   - `lg` 1600 px (zoom)
4. Upload to S3: `catalog-v2/{category}/{slug}/{colorSlug}-{n}-{size}.webp`.
5. Store only the **key** (`mobiles/apple-iphone-17-pro/cosmic-orange-1`) in the document. The API builds full URLs from `S3_PUBLIC_BASE_URL`, so the CDN or bucket can change without rewriting data.

**Alt text** is required for every image (accessibility + SEO).

---

## 6. Designed for the AI / RAG

| Question type | How it's answered | Field(s) used |
|---|---|---|
| "Gaming phone under ₹40k with a big battery" | Vector search **with pre-filters** | `embedding` + filter on `priceRange.min`, `keySpecs.batteryMah`, `category`, `status`, `inStock` |
| "Galaxy S26 Ultra" (exact model) | Keyword side of hybrid search | text index on `title`, `brand`, `searchText` |
| "Does the OnePlus 15 support wireless charging?" | Agent tool `get_product_details(slug)` returns the full `specs` | `specs` (no separate spec embeddings needed) |
| "Is the blue 512GB in stock?" | Variant lookup | `variants[].options`, `stock` |
| "Do people complain about heating?" | Review search tool | `product_reviews` |

**`searchText`** is generated once per product (and whenever specs or description change). It reads like a short paragraph, not a spec dump:

> Apple iPhone 17 Pro — premium flagship smartphone by Apple, priced from ₹1,34,900. 6.3-inch 120Hz OLED display, A19 Pro chip, triple 48MP camera system with telephoto, aluminium unibody, IP68. Best for: photography, video recording, performance. Available in Cosmic Orange, Deep Blue and Silver with 256GB to 1TB storage.

This text is what gets embedded. Numbers stay in it for readability, but **filtering on numbers always happens through `keySpecs` and `priceRange`, never through similarity.**

**Atlas vector index (`catalog_v2_vector`):**
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "status" },
    { "type": "filter", "path": "inStock" },
    { "type": "filter", "path": "category" },
    { "type": "filter", "path": "brand" },
    { "type": "filter", "path": "priceRange.min" },
    { "type": "filter", "path": "keySpecs.ramGB" },
    { "type": "filter", "path": "keySpecs.batteryMah" },
    { "type": "filter", "path": "keySpecs.is5G" }
  ]
}
```

---

## 7. Indexes

```js
catalog_products:
  { slug: 1 }                                  unique
  { "variants.sku": 1 }                        unique
  { category: 1, status: 1, "priceRange.min": 1 }
  { category: 1, status: 1, "rating.average": -1 }
  { brand: 1, status: 1 }
  { category: 1, "keySpecs.ramGB": 1 }         // add more filter indexes as list-page usage shows
  { title: "text", brand: "text", searchText: "text" }   weights: title 10, brand 5, searchText 1
categories:
  { slug: 1 } unique, { parent: 1, sortOrder: 1 }
product_reviews:
  { productId: 1, createdAt: -1 }, { productId: 1, rating: -1 }
```

---

## 8. API (v2)

| Method | Route | Notes |
|---|---|---|
| GET | `/api/v2/categories` | Tree with counts |
| GET | `/api/v2/categories/:slug` | Includes `filters` so the frontend can build the filter sidebar |
| GET | `/api/v2/products?category=&brand=&minPrice=&maxPrice=&ramGB=&sort=&page=` | List: returns card fields + default variant + price range |
| GET | `/api/v2/products/:slug` | Full product + variants + resolved image URLs |
| GET | `/api/v2/products/:slug/reviews?page=&sort=` | Paged reviews |
| GET | `/api/v2/products/:slug/similar` | Vector similarity (same as today's recommendations) |
| POST/PUT/DELETE | `/api/v2/admin/products…` | Admin CRUD with variant editor; re-embeds on content change |

**Implemented so far** (`routes/catalogV2.routes.js`, `services/catalogV2.service.js`):
- `GET /api/v2/categories`: storefront groups (fashion split by gender, large appliances grouped) with counts.
- `GET /api/v2/products?category=&brand=a,b&minPrice=&maxPrice=&minDiscount=&inStock=&q=&sort=featured|price-asc|price-desc|discount|newest&page=&limit=`: cards plus `facets.brands` and `facets.price`.
- `GET /api/v2/products/:slug`: full product, media resolved to `thumb`/`md`/`lg` URLs from `S3_PUBLIC_BASE_URL` (default: the S3 bucket URL).
- `GET /api/v2/products/:slug/similar`: `$vectorSearch` on `catalog_v2_vector`, falling back to same category, closest price.
- `GET /api/v2/delivery/:pincode?category=`: delivery estimate for a PIN code (`services/delivery.service.js`). Checks the code against India Post's directory in the `pincodes` collection (`npm run pincodes:import -- --file=<csv>` or `--api-key=<data.gov.in key>`); before that import, the state comes from the PIN prefix. Returns the place, a zone measured from sample warehouses (`metro` 1-2 days, `regional` 2-3, `national` 3-5, `remote` 6-9; large appliances +1 day with installation), and cash-on-delivery availability. Estimates only, not a courier API.
- Drafts are visible until `CATALOG_V2_ACTIVE_ONLY=true`. Responses are cached under `v2:*`; the import script clears it.

---

## 9. Cart, wishlist and orders

These are the parts of the existing app that must change for variants.

**Cart line (v2):**
```js
{ productId, sku, quantity, addedAt }
```
- Only ids and quantity are stored. Title, image and price are resolved from the product when the cart is read, so prices are never stale.
- Wishlist stores `{ productId, sku?, addedAt }`.

**Placing an order:**
- The server re-prices every line from `variants[sku].price` (+ active sale), as `order.controller.js` already does for v1 products.
- Stock decrements atomically per variant:
  ```js
  updateOne(
    { _id: productId, variants: { $elemMatch: { sku, stock: { $gte: qty } } } },
    { $inc: { "variants.$.stock": -qty } }
  )
  ```
  If `modifiedCount === 0`, return "insufficient stock".
- The order line keeps a snapshot: `{ productId, sku, title, variantLabel: "256GB · Cosmic Orange", image, price, mrp, quantity }`.

**Coexistence:** while v1 and v2 run side by side, cart lines carry `catalog: "v1" | "v2"` so checkout knows which model to price from.

---

## 10. Frontend (vkart repo)

- **`/shop-v2` list page:** category filters built from `category.filters` (price slider, brand, RAM, battery…), sort, and cards showing default-variant image, price range and rating.
- **Product page:**
  - image gallery that switches by color
  - storage and color pickers (unavailable combos disabled)
  - price, MRP and discount
  - highlights, a grouped spec table, "In the box", and paged reviews
- **Cart and checkout** show the variant label ("256GB · Deep Blue").

---

## 11. Data files and import

- One JSON file per product, for easy review in diffs:
  `data/catalog-v2/mobiles/apple-iphone-17-pro.json`
- Each file holds the product document from §3 **minus** generated fields (`embedding`, `searchText`, `priceRange`, `rating`). `media` holds **source image URLs** until the import script converts them to S3 keys.
- `scripts/catalog-v2/import.js`:
  1. validate against the category template
  2. download and convert images → S3
  3. upsert by `slug`
  4. generate `searchText` + `useCases`, then embed
- It can be run again safely; unchanged products are skipped (content hash).

---

## 12. Open questions

- [ ] Reviews: seed demo reviews for v2 (marked `seeded`), or start with none and only real user reviews?
- [ ] Stock: realistic random numbers per variant, or a fixed default (e.g. 50)?
- [ ] Prices: use current Indian MRP/listing price as `price` and `mrp` equal, then show festival discounts through the Sale model? (Proposed: yes.)
- [ ] Motorola: add later via manual image download, or leave out of v2 mobiles?

import mongoose from "mongoose";
const { Schema } = mongoose;

// Catalog v2 product: one document per model with its variants embedded.
// See CATALOG_V2_SCHEMA.md §3 for the field reference.

/* ------------ Variant ------------ */
const variantSchema = new Schema(
  {
    sku: { type: String, required: true, trim: true },
    mpn: { type: String, default: null },
    options: { type: Schema.Types.Mixed, default: {} },
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    isDefault: { type: Boolean, default: false },
    keySpecs: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

/* ------------ Main Catalog Product Schema ------------ */
const catalogProductSchema = new Schema(
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    brand: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    categoryPath: { type: [String], default: [] },
    status: { type: String, enum: ["draft", "active", "archived"], default: "draft" },
    launchDate: String,

    shortDescription: String,
    description: String,
    highlights: { type: [String], default: [] },

    specs: { type: Schema.Types.Mixed, default: {} },
    keySpecs: { type: Schema.Types.Mixed, default: {} },

    variantOptions: { type: Schema.Types.Mixed, default: [] },
    media: { type: Schema.Types.Mixed, default: {} },
    variants: { type: [variantSchema], default: [] },

    // Denormalized from variants on every import/save
    priceRange: { min: Number, max: Number },
    inStock: { type: Boolean, default: false },

    inTheBox: { type: [String], default: [] },
    warranty: { type: String, default: null },
    returnPolicy: String,

    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },

    // AI
    useCases: { type: [String], default: [] },
    searchText: String,
    embedding: { type: [Number], select: false },
    embeddingUpdatedAt: Date,
    contentHash: String,

    source: { type: Schema.Types.Mixed, default: {} },
    seo: { metaTitle: String, metaDescription: String },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "catalog_products", minimize: false }
);

/* ------------ Indexes ------------ */
catalogProductSchema.index({ slug: 1 }, { unique: true });
catalogProductSchema.index({ "variants.sku": 1 }, { unique: true });
catalogProductSchema.index({ category: 1, status: 1, "priceRange.min": 1 });
catalogProductSchema.index({ category: 1, status: 1, "rating.average": -1 });
catalogProductSchema.index({ brand: 1, status: 1 });
catalogProductSchema.index(
  { title: "text", brand: "text", searchText: "text" },
  { weights: { title: 10, brand: 5, searchText: 1 }, name: "catalog_v2_text" }
);

const CatalogProduct = mongoose.model("CatalogProduct", catalogProductSchema);
export default CatalogProduct;

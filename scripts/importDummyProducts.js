import mongoose from "mongoose";
import axios from "axios";
import Product from "../models/Product.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://balavardhan12178:itUwOI4YXYvZh2Qs@vkart.ixjzyfj.mongodb.net/vkart?retryWrites=true&w=majority";

async function importProducts() {
  try {
    console.log("⏳ Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected.");

    console.log("⏳ Fetching DummyJSON products...");
    const { data } = await axios.get("https://dummyjson.com/products?limit=200");
    const items = data?.products || [];

    if (!items.length) {
      console.log("❌ No products found.");
      process.exit(0);
    }

    console.log(`🔄 Mapping ${items.length} products...`);

    const mapped = items.map((p) => ({
      title: p.title,
      description: p.description,
      category: p.category,
      brand: p.brand || "",
      price: p.price,
      discountPercentage: p.discountPercentage || 0,
      rating: p.rating || 0,
      stock: p.stock || 0,

      sku: p.sku || "",
      tags: p.tags || [],
      weight: p.weight || null,
      dimensions: p.dimensions || null,

      warrantyInformation: p.warrantyInformation || "",
      shippingInformation: p.shippingInformation || "",
      availabilityStatus: p.availabilityStatus || "",
      returnPolicy: p.returnPolicy || "",
      minimumOrderQuantity: p.minimumOrderQuantity || 1,

      images: p.images || [],
      thumbnail: p.thumbnail || "",

      reviews:
        p.reviews?.map((r) => ({
          rating: r.rating,
          comment: r.comment,
          date: r.date,
          reviewerName: r.reviewerName,
          reviewerEmail: r.reviewerEmail,
        })) || [],

      meta: {
        barcode: p.meta?.barcode || "",
        qrCode: p.meta?.qrCode || "",
        createdAt: p.meta?.createdAt || "",
        updatedAt: p.meta?.updatedAt || "",
      },

      createdBy: null,
      isActive: true,
    }));

    console.log("🗑️ Deleting existing products...");
    await Product.deleteMany();

    console.log("⬆️ Inserting new products...");
    await Product.insertMany(mapped);

    console.log(`🎉 Successfully imported ${mapped.length} products.`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Import failed:", err);
    process.exit(1);
  }
}

importProducts();

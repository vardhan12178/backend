/**
 * Deterministic local/E2E seed: a small catalog across the home page's hero
 * categories, a shopper with wallet balance, a super admin, a Prime plan and
 * a public coupon. Product images point at the storefront's own bundled
 * assets so nothing depends on third-party image hosts.
 *
 * WIPES the target database first, so it refuses to run unless the database
 * name contains "dev", "e2e" or "test" (or SEED_FORCE=1 is set).
 *
 *   MONGO_URI=mongodb://localhost:27017/vkart_dev?replicaSet=rs0 node scripts/seed-dev.js
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import Product from "../models/Product.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import Coupon from "../models/Coupon.js";
import MembershipPlan from "../models/MembershipPlan.js";

dotenv.config();

export const SEED_USERS = {
  shopper: { username: "shopper", email: "shopper@vkart.test", password: "Shopper@123", name: "Asha Shopper" },
  admin: { username: "opsadmin", email: "admin@vkart.test", password: "Admin@12345", name: "Ops Admin" },
};

const IMG = {
  smartphones: "/assets/categories/editorial-smartphones-v2.webp",
  laptops: "/assets/categories/editorial-laptops-v2.webp",
  "mens-watches": "/assets/categories/editorial-watches-v2.webp",
  fragrances: "/assets/categories/editorial-fragrances-v2.webp",
};

const CATALOG = {
  smartphones: [
    ["Pixel 9a", "Google", 49999, 12],
    ["Galaxy S25", "Samsung", 74999, 8],
    ["iPhone 16", "Apple", 79900, 5],
    ["Nord 5", "OnePlus", 31999, 15],
    ["Edge 60", "Motorola", 25999, 10],
    ["Redmi Note 15 Pro", "Xiaomi", 23999, 20],
  ],
  laptops: [
    ["MacBook Air M4", "Apple", 114900, 6],
    ["ZenBook 14 OLED", "ASUS", 89990, 0], // deliberately out of stock
    ["ThinkPad X1 Carbon", "Lenovo", 159990, 4],
    ["XPS 13", "Dell", 129990, 7],
    ["Spectre x360", "HP", 139990, 3],
    ["Swift Go 14", "Acer", 64990, 9],
  ],
  "mens-watches": [
    ["Seamaster Diver 300M", "Omega", 489000, 2],
    ["PRX Powermatic 80", "Tissot", 64000, 6],
    ["Khaki Field Mechanical", "Hamilton", 52000, 5],
    ["Presage Cocktail Time", "Seiko", 38500, 8],
    ["Eco-Drive Promaster", "Citizen", 29999, 12],
    ["Defender Chronograph", "Titan", 12995, 25],
  ],
  fragrances: [
    ["Bleu de Chanel EDP", "Chanel", 13900, 10],
    ["Sauvage EDT", "Dior", 9800, 14],
    ["Luna Rossa Carbon", "Prada", 8900, 9],
    ["Wood Sage & Sea Salt", "Jo Malone", 11500, 6],
    ["Aventus", "Creed", 32500, 3],
    ["Ombre Nomade", "Louis Vuitton", 28500, 2],
  ],
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export function buildProducts() {
  const products = [];
  let n = 0;
  for (const [category, rows] of Object.entries(CATALOG)) {
    for (const [model, brand, price, stock] of rows) {
      n += 1;
      products.push({
        title: `${brand} ${model}`,
        description: `${brand} ${model} — a considered pick from the VKart ${category.replace("-", " ")} edit.`,
        category,
        brand,
        price,
        discountPercentage: n % 3 === 0 ? 10 : 0,
        rating: 3.8 + (n % 12) / 10,
        stock,
        sku: `SEED-${slug(brand)}-${n}`.toUpperCase(),
        tags: [category, slug(brand)],
        thumbnail: IMG[category],
        images: [IMG[category]],
        isActive: true,
        isFeatured: true,
        returnPolicy: "7 days return",
        warrantyInformation: "1 year manufacturer warranty",
        shippingInformation: "Ships in 2 days",
      });
    }
  }
  return products;
}

export async function seed() {
  const dbName = mongoose.connection.db.databaseName;
  if (!/dev|e2e|test/i.test(dbName) && process.env.SEED_FORCE !== "1") {
    throw new Error(`Refusing to wipe database "${dbName}" (name must contain dev/e2e/test, or set SEED_FORCE=1)`);
  }

  await Promise.all([
    Product.deleteMany({}),
    User.deleteMany({}),
    Order.deleteMany({}),
    Coupon.deleteMany({}),
    MembershipPlan.deleteMany({}),
  ]);

  await Product.insertMany(buildProducts());

  const hash = (pw) => bcrypt.hash(pw, 10);
  await User.create({
    ...SEED_USERS.shopper,
    password: await hash(SEED_USERS.shopper.password),
    emailVerified: true,
    walletBalance: 500000,
  });
  await User.create({
    ...SEED_USERS.admin,
    password: await hash(SEED_USERS.admin.password),
    emailVerified: true,
    roles: ["admin"],
    adminRole: "super_admin",
  });

  await MembershipPlan.create([
    { name: "Monthly", slug: "monthly", durationDays: 30, price: 149, isActive: true, sortOrder: 1 },
    { name: "Yearly", slug: "yearly", durationDays: 365, price: 999, isActive: true, sortOrder: 2 },
  ]);

  await Coupon.create({
    code: "WELCOME10",
    description: "10% off your first order",
    type: "percent",
    value: 10,
    maxDiscount: 2000,
    validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    isPublic: true,
    perUserLimit: 5,
  });

  return { products: await Product.countDocuments() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const result = await seed();
    console.log(`Seeded ${result.products} products, users: ${Object.values(SEED_USERS).map((u) => u.username).join(", ")}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

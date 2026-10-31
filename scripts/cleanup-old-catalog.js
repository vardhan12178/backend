import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/Order.js";
import User from "../models/User.js";

// One-off cleanup after retiring the old product catalog (the `products` collection).
//
//   npm run cleanup:old-catalog              # dry run: prints what would be removed
//   npm run cleanup:old-catalog -- --apply   # removes it
//
// Removes orders that contain any line from the old catalog, old-catalog lines in saved carts
// and wishlists, and the old `products` collection itself. Catalog products are untouched.

dotenv.config();

const OLD_LINE = { $elemMatch: { catalog: { $ne: "v2" } } };

export async function cleanupOldCatalog({ apply = false, db = mongoose.connection.db, log = console.log } = {}) {
  const orders = await Order.countDocuments({ products: OLD_LINE });
  const carts = await User.countDocuments({ cart: OLD_LINE });
  const wishlists = await User.countDocuments({ wishlist: OLD_LINE });
  const hasProducts = (await db.listCollections({ name: "products" }).toArray()).length > 0;
  const products = hasProducts ? await db.collection("products").countDocuments() : 0;

  log(`Orders with old-catalog items: ${orders}`);
  log(`Users with old items in their cart: ${carts}, in their wishlist: ${wishlists}`);
  log(`Old products collection: ${hasProducts ? `${products} documents` : "not present"}`);
  if (!apply) {
    log("Dry run: nothing changed. Re-run with --apply to remove the above.");
    return { orders, carts, wishlists, products, applied: false };
  }

  const deleted = await Order.deleteMany({ products: OLD_LINE });
  const cartRes = await User.updateMany({ cart: OLD_LINE }, { $pull: { cart: { catalog: { $ne: "v2" } } } });
  const wishRes = await User.updateMany({ wishlist: OLD_LINE }, { $pull: { wishlist: { catalog: { $ne: "v2" } } } });
  if (hasProducts) await db.dropCollection("products");
  log(`Removed ${deleted.deletedCount} orders, cleaned ${cartRes.modifiedCount} carts and ${wishRes.modifiedCount} wishlists${hasProducts ? ", dropped the products collection" : ""}.`);
  return { orders: deleted.deletedCount, carts: cartRes.modifiedCount, wishlists: wishRes.modifiedCount, products, applied: true };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("Error: Missing MONGO_URI.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await cleanupOldCatalog({ apply: process.argv.includes("--apply") });
    if (process.argv.includes("--apply") && process.env.REDIS_URL) {
      const { default: redis, invalidatePattern } = await import("../utils/redis.js");
      await invalidatePattern("products:*");
      redis.disconnect();
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

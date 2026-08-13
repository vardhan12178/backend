// One-off migration: promote an existing account to super_admin so it
// bypasses the new permissions matrix entirely.
//
// Usage:
//   node scripts/set-super-admin.js you@example.com
//
// Defaults to balavardhanpula@gmail.com if no email is passed.

import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

const email = (process.argv[2] || "balavardhanpula@gmail.com").trim().toLowerCase();

if (!process.env.MONGO_URI) {
  console.error("Error: Missing MONGO_URI.");
  process.exit(1);
}

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("[INFO] MongoDB connected.");

    const user = await User.findOne({ email });
    if (!user) {
      console.error(`[ERROR] No account found with email "${email}".`);
      process.exit(1);
    }

    const roles = Array.isArray(user.roles) ? user.roles : ["user"];
    user.roles = Array.from(new Set([...roles, "admin"]));
    user.adminRole = "super_admin";
    user.permissions = {}; // irrelevant for super_admin — bypassed in middleware

    await user.save();
    console.log(`[INFO] ${email} is now super_admin.`);
  } catch (err) {
    console.error("[ERROR]", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

run();

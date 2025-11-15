// routes/admin.users.routes.js
import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";

import User from "../models/User.js";
import { authenticateJWT } from "../middleware/auth.js";
import { isAdmin } from "../middleware/admin.js";

const router = express.Router();

/* ---------------------- GET ALL USERS ---------------------- */
router.get("/users", authenticateJWT, isAdmin, async (req, res) => {
  try {
    const users = await User.find({})
      .select("name username email profileImage createdAt twoFactorEnabled blocked");

    res.json({ users });
  } catch (err) {
    console.error("Admin get users error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* ---------------------- BLOCK / UNBLOCK USER ---------------------- */
router.patch("/users/:id/block", authenticateJWT, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: "User not found" });

    user.blocked = !user.blocked;
    await user.save();

    res.json({
      message: user.blocked ? "User blocked successfully" : "User unblocked successfully",
      blocked: user.blocked,
    });
  } catch (err) {
    console.error("Admin block user error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* ---------------------- RESET USER PASSWORD ---------------------- */
router.patch("/users/:id/reset-password", authenticateJWT, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const tempPassword = crypto.randomBytes(6).toString("hex");
    user.password = await bcrypt.hash(tempPassword, 11);
    await user.save();

    res.json({
      message: "Password reset successfully",
      tempPassword,
    });
  } catch (err) {
    console.error("Admin reset pass error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* ---------------------- DISABLE USER 2FA ---------------------- */
router.patch("/users/:id/disable-2fa", authenticateJWT, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("+twoFactorSecret +twoFactorSecretEnc +twoFactorBackupCodes");

    if (!user) return res.status(404).json({ message: "User not found" });

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.twoFactorSecretEnc = undefined;
    user.twoFactorBackupCodes = [];
    user.suppress2faPrompt = false;

    await user.save();

    res.json({ message: "2FA disabled successfully" });
  } catch (err) {
    console.error("Admin disable 2FA error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* ---------------------- DELETE USER ---------------------- */
router.delete("/users/:id", authenticateJWT, isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Admin delete user error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


export default router;

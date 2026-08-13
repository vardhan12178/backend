import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as adminController from "../controllers/admin.users.controller.js";

const router = express.Router();

// Get all users
router.get("/users", authenticateJWT, requirePermission("users", "read"), adminController.getUsers);

// Block/Unblock user
router.patch("/users/:id/block", authenticateJWT, requirePermission("users", "write"), adminController.toggleBlockUser);

// Reset user password
router.patch("/users/:id/reset-password", authenticateJWT, requirePermission("users", "write"), adminController.resetUserPassword);

// Disable user 2FA
router.patch("/users/:id/disable-2fa", authenticateJWT, requirePermission("users", "write"), adminController.disableUser2FA);

// Delete user
router.delete("/users/:id", authenticateJWT, requirePermission("users", "write"), adminController.deleteUser);

export default router;

import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { isAdmin } from "../middleware/admin.js";
import * as adminController from "../controllers/admin.users.controller.js";

const router = express.Router();

// Get all users
router.get("/users", authenticateJWT, isAdmin, adminController.getUsers);

// Block/Unblock user
router.patch("/users/:id/block", authenticateJWT, isAdmin, adminController.toggleBlockUser);

// Reset user password
router.patch("/users/:id/reset-password", authenticateJWT, isAdmin, adminController.resetUserPassword);

// Disable user 2FA
router.patch("/users/:id/disable-2fa", authenticateJWT, isAdmin, adminController.disableUser2FA);

// Toggle admin role
router.patch("/users/:id/role", authenticateJWT, isAdmin, adminController.toggleAdminRole);

// Delete user
router.delete("/users/:id", authenticateJWT, isAdmin, adminController.deleteUser);

export default router;

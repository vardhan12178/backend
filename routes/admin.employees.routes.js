import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission, requireSuperAdminForRoleAssignment } from "../middleware/permissions.js";
import * as employeesController from "../controllers/admin.employees.controller.js";

const router = express.Router();

router.get(
  "/",
  authenticateJWT,
  requirePermission("employees", "read"),
  employeesController.listEmployees
);

router.post(
  "/",
  authenticateJWT,
  requirePermission("employees", "write"),
  requireSuperAdminForRoleAssignment,
  employeesController.addEmployee
);

router.patch(
  "/:id",
  authenticateJWT,
  requirePermission("employees", "write"),
  requireSuperAdminForRoleAssignment,
  employeesController.updateEmployee
);

router.delete(
  "/:id",
  authenticateJWT,
  requirePermission("employees", "write"),
  employeesController.revokeEmployee
);

export default router;

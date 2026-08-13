import User from "../models/User.js";
import { isValidModule, isValidPermissionLevel } from "../config/permissions.js";

/**
 * Module/level permission gate for the admin panel.
 *
 * Looks the acting user up fresh from the DB on every request (rather than
 * trusting permissions baked into the JWT) so that revoking or downgrading
 * an employee's access takes effect immediately, without waiting for their
 * token to expire or requiring them to log out.
 *
 * super_admin bypasses this entirely — full access, no permissions lookup
 * needed.
 */
export function requirePermission(module, level = "read") {
  if (!isValidModule(module) || !isValidPermissionLevel(level)) {
    throw new Error(`requirePermission: invalid module/level "${module}"/"${level}"`);
  }

  return async (req, res, next) => {
    try {
      if (!req.user?.userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const user = await User.findById(req.user.userId).select(
        "roles adminRole permissions blocked"
      );

      if (!user || user.blocked) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const roles = Array.isArray(user.roles) ? user.roles : [];
      if (!roles.includes("admin")) {
        return res.status(403).json({ message: "Admin access required" });
      }

      if (user.adminRole === "super_admin") {
        req.adminUser = user;
        return next();
      }

      const granted = user.permissions?.get ? user.permissions.get(module) : user.permissions?.[module];
      const allowed =
        level === "read" ? granted === "read" || granted === "write" : granted === "write";

      if (!allowed) {
        return res.status(403).json({ message: `Missing ${level} access to ${module}` });
      }

      req.adminUser = user;
      next();
    } catch (err) {
      console.error("requirePermission error:", err.message);
      res.status(500).json({ message: "Internal server error" });
    }
  };
}

/**
 * Extra guard stacked alongside requirePermission("employees", "write") on
 * any route that can assign/change an employee's adminRole. Blocks anyone
 * who isn't already super_admin from granting super_admin to someone else
 * (or themselves), even though they may otherwise have write access to the
 * Employees module.
 *
 * Relies on req.adminUser, populated by requirePermission — must run after it.
 */
export function requireSuperAdminForRoleAssignment(req, res, next) {
  const requestedRole = req.body?.adminRole;
  if (requestedRole === "super_admin" && req.adminUser?.adminRole !== "super_admin") {
    return res.status(403).json({ message: "Only a super admin can grant super admin access" });
  }
  next();
}

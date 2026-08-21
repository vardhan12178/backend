// Single source of truth for admin RBAC: the module list and role presets.
// Authorization itself never reads ROLE_PRESETS — it only reads a user's
// stored `permissions` map. Presets exist purely to pre-fill the UI/API
// payload when an employee is first assigned a role.

export const MODULES = [
  "products",
  "orders",
  "coupons",
  "sales",
  "membership",
  "users",
  "reviews",
  "settings",
  "marketing",
  "notifications",
  "employees",
  "support",
];

export const ADMIN_ROLES = [
  "super_admin",
  "product_manager",
  "customer_service",
  "reviewer",
  "order_manager",
  "sales_manager",
  "customer_support",
];

// Roles an employee-with-write-access-to-Employees is allowed to assign.
// super_admin is deliberately excluded here — only an existing super_admin
// can grant it (enforced in middleware/permissions.js, not just this list).
export const ASSIGNABLE_ROLES_FOR_NON_SUPER_ADMIN = ADMIN_ROLES.filter(
  (r) => r !== "super_admin"
);

// Every non-super-admin role gets read access to its own notification feed
// by default — otherwise the admin-header bell 403s for every employee, since
// nothing else grants the `notifications` module.
export const ROLE_PRESETS = {
  super_admin: {}, // irrelevant — super_admin bypasses the permissions map entirely
  product_manager: { products: "write", notifications: "read" },
  customer_service: { users: "write", notifications: "read" },
  reviewer: { reviews: "write", notifications: "read" },
  order_manager: { orders: "write", notifications: "read" },
  sales_manager: { coupons: "write", sales: "write", membership: "write", marketing: "write", notifications: "read" },
  // Scoped to the support inbox plus read-only order context — distinct
  // from order_manager (which can write orders but has no support access)
  // and from customer_service (which is really account moderation:
  // users:write, not customer-facing support).
  customer_support: { support: "write", orders: "read", notifications: "read" },
};

export function isValidModule(module) {
  return MODULES.includes(module);
}

export function isValidPermissionLevel(level) {
  return level === "read" || level === "write";
}

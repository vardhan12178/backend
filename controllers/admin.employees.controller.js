import User from "../models/User.js";
import {
  ADMIN_ROLES,
  MODULES,
  ROLE_PRESETS,
} from "../config/permissions.js";

const EMPLOYEE_SELECT =
  "name username email profileImage createdAt blocked roles adminRole permissions";

function sanitizePermissions(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const module of MODULES) {
    const level = input[module];
    if (level === "read" || level === "write") out[module] = level;
  }
  return out;
}

function toEmployeeJSON(user) {
  const obj = user.toObject ? user.toObject() : user;
  return {
    _id: obj._id,
    name: obj.name,
    username: obj.username,
    email: obj.email,
    profileImage: obj.profileImage,
    blocked: obj.blocked,
    adminRole: obj.adminRole || null,
    permissions: obj.permissions || {},
    createdAt: obj.createdAt,
  };
}

/* ---------------------- LIST EMPLOYEES ---------------------- */
export const listEmployees = async (req, res) => {
  try {
    const employees = await User.find({ roles: "admin" }).select(EMPLOYEE_SELECT);
    res.json({ employees: employees.map(toEmployeeJSON) });
  } catch (err) {
    console.error("List employees error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* ---------------------- ADD EMPLOYEE ---------------------- */
export const addEmployee = async (req, res) => {
  try {
    const { email, adminRole, permissions } = req.body;

    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "Email is required" });
    }
    if (!ADMIN_ROLES.includes(adminRole)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({
        message: "No account found with that email. They need to sign up first.",
      });
    }
    if (user.adminRole) {
      return res.status(409).json({
        message: "This user is already an employee. Use the edit action to change their access.",
      });
    }

    const roles = Array.isArray(user.roles) ? user.roles : ["user"];
    user.roles = Array.from(new Set([...roles, "admin"]));
    user.adminRole = adminRole;
    user.permissions =
      adminRole === "super_admin"
        ? {}
        : sanitizePermissions(permissions ?? ROLE_PRESETS[adminRole]);

    await user.save();
    res.status(201).json({ message: "Employee added", employee: toEmployeeJSON(user) });
  } catch (err) {
    console.error("Add employee error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* ---------------------- UPDATE EMPLOYEE ---------------------- */
export const updateEmployee = async (req, res) => {
  try {
    const { adminRole, permissions } = req.body;

    if (req.params.id === req.user.userId) {
      return res.status(400).json({ message: "Cannot modify your own access here" });
    }
    if (!ADMIN_ROLES.includes(adminRole)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "Employee not found" });

    if (target.adminRole === "super_admin" && req.adminUser?.adminRole !== "super_admin") {
      return res.status(403).json({ message: "Only a super admin can modify another super admin" });
    }

    const roles = Array.isArray(target.roles) ? target.roles : ["user"];
    target.roles = Array.from(new Set([...roles, "admin"]));
    target.adminRole = adminRole;
    target.permissions =
      adminRole === "super_admin" ? {} : sanitizePermissions(permissions ?? {});

    await target.save();
    res.json({ message: "Employee updated", employee: toEmployeeJSON(target) });
  } catch (err) {
    console.error("Update employee error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/* ---------------------- REVOKE EMPLOYEE ACCESS ---------------------- */
export const revokeEmployee = async (req, res) => {
  try {
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ message: "Cannot revoke your own access" });
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "Employee not found" });

    if (target.adminRole === "super_admin" && req.adminUser?.adminRole !== "super_admin") {
      return res.status(403).json({ message: "Only a super admin can revoke another super admin" });
    }

    target.adminRole = null;
    target.permissions = {};
    target.roles = (Array.isArray(target.roles) ? target.roles : []).filter((r) => r !== "admin");

    await target.save();
    res.json({ message: "Employee access revoked" });
  } catch (err) {
    console.error("Revoke employee error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

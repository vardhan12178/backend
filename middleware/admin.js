// middleware/admin.js
export function isAdmin(req, res, next) {
    try {
      // req.user is injected by auth.js after verifying JWT
      if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ message: "Admin access only" });
      }
      next();
    } catch (err) {
      console.error("Admin middleware error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
  
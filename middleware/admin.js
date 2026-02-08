// middleware/admin.js
export function isAdmin(req, res, next) {
    try {
      // req.user is injected by auth.js after verifying JWT
      const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
      if (!req.user || !roles.includes("admin")) {
        return res.status(403).json({ message: "Admin access only" });
      }
      next();
    } catch (err) {
      console.error("Admin middleware error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
  

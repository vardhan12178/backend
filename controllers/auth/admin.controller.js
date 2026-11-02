import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../../models/User.js";
import { isTokenRevoked } from "../../utils/tokenBlacklist.js";
import { buildCookieOpts } from "../../utils/cookies.js";
import { GOOGLE_CLIENT_ID, googleClient } from "./shared.js";

// Admin Login
export const adminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Invalid payload" });

    const id = String(username).trim().toLowerCase();
    const user = await User.findOne({ $or: [{ username: id }, { email: id }] }).select("+password");

    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: "Invalid credentials" });

    if (user.blocked) {
      return res.status(403).json({ message: "Account suspended. Contact support." });
    }

    const roles = Array.isArray(user.roles) ? user.roles : ["user"];
    if (!roles.includes("admin")) {
      return res.status(403).json({ message: "Access denied: Not an admin" });
    }

    // adminRole is carried in the token for display/UX only, every
    // permission-gated route re-checks the DB (see middleware/permissions.js),
    // so this never needs to be trusted for authorization.
    const token = jwt.sign(
      { userId: user._id, roles, adminRole: user.adminRole || null },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.cookie("jwt_token", token, buildCookieOpts(req, true));
    res.json({ token, role: "admin" });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Admin Google Auth
export const adminGoogleAuth = async (req, res) => {
  try {
    const credential = req.body.credential || req.body.idToken;
    if (!credential) return res.status(400).json({ message: "Missing Google credential" });
    if (!googleClient) return res.status(500).json({ message: "Google client not configured" });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();

    if (!email) {
      return res.status(400).json({ message: "Google account missing email" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(403).json({ message: "Access denied: Not an admin" });
    }

    const roles = Array.isArray(user.roles) ? user.roles : ["user"];
    if (!roles.includes("admin")) {
      return res.status(403).json({ message: "Access denied: Not an admin" });
    }

    const token = jwt.sign(
      { userId: user._id, roles, adminRole: user.adminRole || null },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.cookie("jwt_token", token, buildCookieOpts(req, true));
    res.json({ token, role: "admin" });
  } catch (err) {
    console.error("Admin Google login error:", err.message);
    res.status(401).json({ message: "Google sign-in failed" });
  }
};

// Admin Verify
export const verifyAdmin = async (req, res) => {
  try {
    const token = req.cookies.jwt_token || req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ valid: false, message: "No token" });

    // Keep admin verify aligned with authenticateJWT behavior.
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ valid: false, message: "Token invalidated" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const roles = Array.isArray(decoded?.roles) ? decoded.roles : [];
    if (!roles.includes("admin")) {
      return res.status(401).json({ valid: false, message: "Not an admin" });
    }

    const user = await User.findById(decoded.userId);
    if (!user || user.blocked) {
      return res.status(401).json({ valid: false, message: "Invalid user" });
    }

    // Always read fresh from the DB (not the token) so the header, sidebar
    // and route-guards reflect any access/profile change immediately.
    // This is the one endpoint every logged-in admin can hit regardless of
    // their module permissions, so it also carries basic identity, pages
    // like "My Profile" shouldn't need a settings-gated call just to know
    // who's logged in.
    const permissions = user.permissions ? Object.fromEntries(user.permissions) : {};

    res.json({
      valid: true,
      adminRole: user.adminRole || null,
      permissions,
      name: user.name || "",
      email: user.email,
      username: user.username,
      profileImage: user.profileImage || null,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error("Admin verify error:", err.message);
    res.status(401).json({ valid: false, message: "Invalid token" });
  }
};

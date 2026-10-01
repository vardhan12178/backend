import express from "express";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import { vitalsLimiter } from "../middleware/security.js";
import { recordVital, getVitalsSummary } from "../controllers/vitals.controller.js";

const router = express.Router();

// Public: the storefront beacons Core Web Vitals here (navigator.sendBeacon,
// so no auth header / CSRF token — exempted in middleware/security.js).
router.post("/vitals", vitalsLimiter, recordVital);

// Admin dashboard summary
router.get("/admin/vitals", authenticateJWT, requireAdmin, getVitalsSummary);

export default router;

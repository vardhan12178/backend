import express from "express";
import { body, param } from "express-validator";
import validate from "../middleware/validate.js";
import { authenticateJWT } from "../middleware/auth.js";
import * as alerts from "../controllers/alerts.controller.js";

// Mounted at /api/alerts: price-drop and back-in-stock alerts for the signed-in shopper
const router = express.Router();

router.get("/", authenticateJWT, alerts.list);
router.post(
  "/",
  authenticateJWT,
  [
    body("productId").isMongoId(),
    body("sku").isString().trim().isLength({ min: 1, max: 80 }),
    body("kind").isIn(["price", "stock"]),
  ],
  validate,
  alerts.create
);
router.delete("/:id", authenticateJWT, [param("id").isMongoId()], validate, alerts.remove);

export default router;

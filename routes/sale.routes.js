import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as saleCtrl from "../controllers/sale.controller.js";

const router = express.Router();

router.get("/active", saleCtrl.getActiveSalePublic);

router.get("/", authenticateJWT, requirePermission("sales", "read"), saleCtrl.listSales);
router.get("/:id", authenticateJWT, requirePermission("sales", "read"), saleCtrl.getSaleById);
router.post("/", authenticateJWT, requirePermission("sales", "write"), saleCtrl.createSale);
router.put("/:id", authenticateJWT, requirePermission("sales", "write"), saleCtrl.updateSale);
router.delete("/:id", authenticateJWT, requirePermission("sales", "write"), saleCtrl.deleteSale);

export default router;

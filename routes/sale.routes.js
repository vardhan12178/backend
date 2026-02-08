import express from "express";
import { authenticateJWT, requireAdmin } from "../middleware/auth.js";
import * as saleCtrl from "../controllers/sale.controller.js";

const router = express.Router();

router.get("/active", saleCtrl.getActiveSalePublic);

router.get("/", authenticateJWT, requireAdmin, saleCtrl.listSales);
router.get("/:id", authenticateJWT, requireAdmin, saleCtrl.getSaleById);
router.post("/", authenticateJWT, requireAdmin, saleCtrl.createSale);
router.put("/:id", authenticateJWT, requireAdmin, saleCtrl.updateSale);
router.delete("/:id", authenticateJWT, requireAdmin, saleCtrl.deleteSale);

export default router;

import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { supportMessageLimiter } from "../middleware/security.js";
import * as adminSupportController from "../controllers/admin.support.controller.js";

const router = express.Router();

router.use(authenticateJWT);

router.get("/conversations", requirePermission("support", "read"), adminSupportController.listConversations);
router.get("/conversations/:id", requirePermission("support", "read"), adminSupportController.getConversation);
router.post(
  "/conversations/:id/messages",
  requirePermission("support", "write"),
  supportMessageLimiter,
  adminSupportController.sendAgentMessage
);
router.patch("/conversations/:id", requirePermission("support", "write"), adminSupportController.updateConversation);

export default router;

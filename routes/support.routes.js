import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { supportMessageLimiter } from "../middleware/security.js";
import * as supportController from "../controllers/support.controller.js";

const router = express.Router();

router.use(authenticateJWT);

router.post("/support/conversations", supportController.createConversation);
router.get("/support/conversations/mine", supportController.getMyConversation);
router.post("/support/conversations/:id/messages", supportMessageLimiter, supportController.sendMessage);

export default router;

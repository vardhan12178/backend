import express from "express";
import { authenticateJWT } from "../middleware/auth.js";
import { supportMessageLimiter } from "../middleware/security.js";
import * as supportController from "../controllers/support.controller.js";

const router = express.Router();

router.post("/support/conversations", authenticateJWT, supportController.createConversation);
router.get("/support/conversations/mine", authenticateJWT, supportController.getMyConversation);
router.post("/support/conversations/:id/messages", authenticateJWT, supportMessageLimiter, supportController.sendMessage);

export default router;

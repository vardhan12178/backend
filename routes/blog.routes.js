import { Router } from "express";
import { listPosts, getPost } from "../controllers/blog.controller.js";

const router = Router();

router.get("/blog", listPosts);
router.get("/blog/:id", getPost);

export default router;

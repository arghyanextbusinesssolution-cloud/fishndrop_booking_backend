import express from "express";
import {
  getPublishedBlogs,
  getBlogBySlug,
  uploadBlogImage,
  createBlog,
  getAllBlogsAdmin,
  getBlogByIdAdmin,
  updateBlog,
  deleteBlog
} from "../controllers/blog.controller";
import authMiddleware from "../middleware/auth.middleware";
import adminOnly from "../middleware/admin.middleware";

const router = express.Router();

// Public routes (no auth required)
router.get("/", getPublishedBlogs);
router.get("/:slug", getBlogBySlug);

// Admin routes (auth + admin required)
router.post("/upload-image", authMiddleware, adminOnly, uploadBlogImage);
router.post("/admin", authMiddleware, adminOnly, createBlog);
router.get("/admin/all", authMiddleware, adminOnly, getAllBlogsAdmin);
router.get("/admin/:id", authMiddleware, adminOnly, getBlogByIdAdmin);
router.patch("/admin/:id", authMiddleware, adminOnly, updateBlog);
router.delete("/admin/:id", authMiddleware, adminOnly, deleteBlog);

export default router;

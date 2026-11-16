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
import { blogEditorOnly } from "../middleware/admin.middleware";

const router = express.Router();

// Public routes (no auth required)
router.get("/", getPublishedBlogs);
router.get("/:slug", getBlogBySlug);

// Blog editor routes: admin/owner + SEO team (role "seo")
router.post("/upload-image", authMiddleware, blogEditorOnly, uploadBlogImage);
router.post("/admin", authMiddleware, blogEditorOnly, createBlog);
router.get("/admin/all", authMiddleware, blogEditorOnly, getAllBlogsAdmin);
router.get("/admin/:id", authMiddleware, blogEditorOnly, getBlogByIdAdmin);
router.patch("/admin/:id", authMiddleware, blogEditorOnly, updateBlog);
router.delete("/admin/:id", authMiddleware, blogEditorOnly, deleteBlog);

export default router;

import express from "express";
import {
  uploadGalleryImage,
  submitGalleryPhoto,
  getMyGalleryPhotos,
  updateMyPhoto,
  deleteMyPhoto,
  getAdminGalleryPhotos,
  publishGalleryPhoto,
  rejectGalleryPhoto,
  deleteGalleryPhotoAdmin,
  getPublicGalleryPhotos,
  adminCreateGalleryPhoto,
  adminUpdateGalleryPhoto
} from "../controllers/gallery.controller";
import authMiddleware from "../middleware/auth.middleware";
import adminOnly from "../middleware/admin.middleware";

const router = express.Router();

// Public routes
router.get("/public", getPublicGalleryPhotos);

// Authenticated User routes (Profile photo uploads & management)
router.post("/upload", authMiddleware, uploadGalleryImage);
router.post("/submit", authMiddleware, submitGalleryPhoto);
router.get("/my-photos", authMiddleware, getMyGalleryPhotos);
router.patch("/my-photos/:id", authMiddleware, updateMyPhoto);
router.put("/my-photos/:id", authMiddleware, updateMyPhoto);
router.delete("/my-photos/:id", authMiddleware, deleteMyPhoto);

// Admin review & photo management routes
router.get("/admin/all", authMiddleware, adminOnly, getAdminGalleryPhotos);
router.post("/admin/create", authMiddleware, adminOnly, adminCreateGalleryPhoto);
router.patch("/admin/:id", authMiddleware, adminOnly, adminUpdateGalleryPhoto);
router.put("/admin/:id", authMiddleware, adminOnly, adminUpdateGalleryPhoto);
router.patch("/admin/:id/publish", authMiddleware, adminOnly, publishGalleryPhoto);
router.patch("/admin/:id/reject", authMiddleware, adminOnly, rejectGalleryPhoto);
router.delete("/admin/:id", authMiddleware, adminOnly, deleteGalleryPhotoAdmin);

export default router;


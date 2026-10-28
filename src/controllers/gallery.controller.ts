import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import Gallery from "../models/Gallery";
import logger from "../config/logger";

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dxx54fccl",
  api_key: process.env.CLOUDINARY_API_KEY || "149937643231624",
  api_secret: process.env.CLOUDINARY_API_SECRET || "whOZPJleA7xJeu_R8kckqq3Lprc"
});

/**
 * Upload an image to Cloudinary for gallery submission
 * POST /api/gallery/upload
 */
export const uploadGalleryImage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      res.status(400).json({ success: false, message: "No image provided" });
      return;
    }

    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: "tropica_gallery",
      resource_type: "image",
      transformation: [
        { width: 1600, crop: "limit" },
        { quality: "auto:good" },
        { fetch_format: "auto" }
      ]
    });

    res.status(200).json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id
    });
  } catch (error: any) {
    logger.error("Gallery image upload error:", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Failed to upload image to cloud storage",
      error: error.message
    });
  }
};

/**
 * User submits a photo to the gallery
 * POST /api/gallery/submit
 */
export const submitGalleryPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user;
    const { title, description, imageUrl, imageUrls, category } = req.body;

    const urls: string[] = Array.isArray(imageUrls) && imageUrls.length > 0
      ? imageUrls.filter((u: any) => typeof u === "string" && u.trim().length > 0)
      : imageUrl ? [imageUrl] : [];

    if (urls.length === 0) {
      res.status(400).json({ success: false, message: "Please upload at least one image" });
      return;
    }

    if (!title || !title.trim()) {
      res.status(400).json({ success: false, message: "Photo title or caption is required" });
      return;
    }

    const createdPhotos = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const photoTitle = urls.length > 1 ? `${title.trim()} (${i + 1})` : title.trim();
      const photo = new Gallery({
        user: user?._id || user?.id,
        userName: user?.name || "Tropica Guest",
        userEmail: user?.email || "",
        userPhone: user?.phone || "",
        title: photoTitle,
        description: (description || "").trim(),
        imageUrl: url.trim(),
        category: category || "guest_memories",
        status: "pending",
        isPublished: false
      });
      await photo.save();
      createdPhotos.push(photo);
    }

    logger.info("New gallery photos submitted for review:", { count: createdPhotos.length });

    res.status(201).json({
      success: true,
      message: `${createdPhotos.length} photo${createdPhotos.length > 1 ? "s" : ""} submitted successfully! Our team will review and publish them to the Sanctuary Gallery.`,
      photo: createdPhotos[0],
      photos: createdPhotos
    });
  } catch (error: any) {
    logger.error("Submit gallery photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to submit photo", error: error.message });
  }
};

/**
 * Get photos submitted by the current authenticated user
 * GET /api/gallery/my-photos
 */
export const getMyGalleryPhotos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user;
    const photos = await Gallery.find({
      $or: [
        { user: user?._id || user?.id },
        ...(user?.email ? [{ userEmail: user.email }] : [])
      ]
    }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      photos
    });
  } catch (error: any) {
    logger.error("Get my gallery photos error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to fetch your photos", error: error.message });
  }
};

/**
 * User deletes their own photo submission
 * DELETE /api/gallery/my-photos/:id
 */
export const deleteMyPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user;
    const { id } = req.params;

    const photo = await Gallery.findOne({
      _id: id,
      $or: [
        { user: user?._id || user?.id },
        ...(user?.email ? [{ userEmail: user.email }] : [])
      ]
    });

    if (!photo) {
      res.status(404).json({ success: false, message: "Photo not found or unauthorized" });
      return;
    }

    await Gallery.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "Photo deleted successfully"
    });
  } catch (error: any) {
    logger.error("Delete my photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to delete photo", error: error.message });
  }
};

/**
 * User updates their own photo submission
 * PATCH /api/gallery/my-photos/:id
 */
export const updateMyPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user;
    const { id } = req.params;
    const { title, description, category, imageUrl } = req.body;

    const photo = await Gallery.findOne({
      _id: id,
      $or: [
        { user: user?._id || user?.id },
        ...(user?.email ? [{ userEmail: user.email }] : [])
      ]
    });

    if (!photo) {
      res.status(404).json({ success: false, message: "Photo not found or unauthorized" });
      return;
    }

    if (title && title.trim()) photo.title = title.trim();
    if (description !== undefined) photo.description = description.trim();
    if (category) photo.category = category;
    if (imageUrl && imageUrl.trim()) photo.imageUrl = imageUrl.trim();

    await photo.save();

    res.status(200).json({
      success: true,
      message: "Photo updated successfully",
      photo
    });
  } catch (error: any) {
    logger.error("Update my photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to update photo", error: error.message });
  }
};

/**
 * Admin: Get all gallery submissions (filter by status optional)
 * GET /api/gallery/admin/all
 */
export const getAdminGalleryPhotos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, category } = req.query;
    const query: any = {};

    if (status && status !== "all") {
      query.status = status;
    }
    if (category && category !== "all") {
      query.category = category;
    }

    const photos = await Gallery.find(query)
      .populate("user", "name email phone")
      .sort({ createdAt: -1 });

    const counts = {
      all: await Gallery.countDocuments(),
      pending: await Gallery.countDocuments({ status: "pending" }),
      approved: await Gallery.countDocuments({ status: "approved" }),
      rejected: await Gallery.countDocuments({ status: "rejected" })
    };

    res.status(200).json({
      success: true,
      photos,
      counts
    });
  } catch (error: any) {
    logger.error("Get admin gallery photos error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to fetch gallery submissions", error: error.message });
  }
};

/**
 * Admin: Approve and publish (or unpublish) a gallery photo
 * PATCH /api/gallery/admin/:id/publish
 */
export const publishGalleryPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminUser = req.user;
    const { id } = req.params;
    const { isPublished } = req.body;

    const photo = await Gallery.findById(id);
    if (!photo) {
      res.status(404).json({ success: false, message: "Photo not found" });
      return;
    }

    const targetPublish = isPublished !== undefined ? Boolean(isPublished) : !photo.isPublished;

    photo.isPublished = targetPublish;
    photo.status = targetPublish ? "approved" : "pending";
    if (targetPublish) {
      photo.approvedBy = adminUser?._id;
      photo.approvedAt = new Date();
      photo.rejectionReason = "";
    }

    await photo.save();

    logger.info("Admin updated gallery photo status:", { id: photo._id, isPublished: photo.isPublished, status: photo.status });

    res.status(200).json({
      success: true,
      message: targetPublish ? "Photo published to the Sanctuary Gallery!" : "Photo unpublished and set to pending.",
      photo
    });
  } catch (error: any) {
    logger.error("Publish gallery photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to update publish state", error: error.message });
  }
};

/**
 * Admin: Reject a gallery photo
 * PATCH /api/gallery/admin/:id/reject
 */
export const rejectGalleryPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const photo = await Gallery.findById(id);
    if (!photo) {
      res.status(404).json({ success: false, message: "Photo not found" });
      return;
    }

    photo.status = "rejected";
    photo.isPublished = false;
    photo.rejectionReason = (reason || "Does not meet gallery publication guidelines").trim();

    await photo.save();

    res.status(200).json({
      success: true,
      message: "Photo submission rejected",
      photo
    });
  } catch (error: any) {
    logger.error("Reject gallery photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to reject photo", error: error.message });
  }
};

/**
 * Admin: Directly create & upload a photo to the gallery
 * POST /api/gallery/admin/create
 */
export const adminCreateGalleryPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminUser = req.user;
    const { title, description, imageUrl, category, isPublished } = req.body;

    if (!title || !title.trim()) {
      res.status(400).json({ success: false, message: "Photo title is required" });
      return;
    }

    if (!imageUrl || !imageUrl.trim()) {
      res.status(400).json({ success: false, message: "Image URL is required" });
      return;
    }

    const shouldPublish = isPublished !== undefined ? Boolean(isPublished) : true;

    const photo = new Gallery({
      user: adminUser?._id,
      userName: adminUser?.name || "Tropica Sanctuary",
      userEmail: adminUser?.email || "",
      title: title.trim(),
      description: (description || "").trim(),
      imageUrl: imageUrl.trim(),
      category: category || "garden",
      status: shouldPublish ? "approved" : "pending",
      isPublished: shouldPublish,
      approvedBy: shouldPublish ? adminUser?._id : undefined,
      approvedAt: shouldPublish ? new Date() : undefined
    });

    await photo.save();

    logger.info("Admin created new gallery photo:", { id: photo._id, title: photo.title, isPublished: photo.isPublished });

    res.status(201).json({
      success: true,
      message: shouldPublish ? "Photo published to the Sanctuary Gallery!" : "Photo saved as draft",
      photo
    });
  } catch (error: any) {
    logger.error("Admin create gallery photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to create photo", error: error.message });
  }
};

/**
 * Admin: Update an existing gallery photo (title, description, category, imageUrl, isPublished, status)
 * PATCH /api/gallery/admin/:id/update
 * PUT /api/gallery/admin/:id
 */
export const adminUpdateGalleryPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminUser = req.user;
    const { id } = req.params;
    const { title, description, category, imageUrl, isPublished, status, rejectionReason } = req.body;

    const photo = await Gallery.findById(id);
    if (!photo) {
      res.status(404).json({ success: false, message: "Photo not found" });
      return;
    }

    if (title && title.trim()) photo.title = title.trim();
    if (description !== undefined) photo.description = description.trim();
    if (category) photo.category = category;
    if (imageUrl && imageUrl.trim()) photo.imageUrl = imageUrl.trim();

    if (isPublished !== undefined) {
      photo.isPublished = Boolean(isPublished);
      if (photo.isPublished) {
        photo.status = "approved";
        photo.approvedBy = adminUser?._id;
        photo.approvedAt = new Date();
        photo.rejectionReason = "";
      }
    }

    if (status) {
      photo.status = status;
      if (status === "approved") {
        photo.isPublished = true;
        photo.approvedBy = adminUser?._id;
        photo.approvedAt = new Date();
      } else if (status === "rejected") {
        photo.isPublished = false;
        if (rejectionReason) photo.rejectionReason = rejectionReason;
      }
    }

    if (rejectionReason !== undefined) {
      photo.rejectionReason = rejectionReason;
    }

    await photo.save();

    logger.info("Admin updated gallery photo:", { id: photo._id, title: photo.title, status: photo.status, isPublished: photo.isPublished });

    res.status(200).json({
      success: true,
      message: "Gallery photo updated successfully",
      photo
    });
  } catch (error: any) {
    logger.error("Admin update gallery photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to update photo", error: error.message });
  }
};

/**
 * Admin: Delete a gallery photo
 * DELETE /api/gallery/admin/:id
 */
export const deleteGalleryPhotoAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const photo = await Gallery.findByIdAndDelete(id);

    if (!photo) {
      res.status(404).json({ success: false, message: "Photo not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Photo removed permanently"
    });
  } catch (error: any) {
    logger.error("Admin delete gallery photo error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to delete photo", error: error.message });
  }
};

/**
 * Public: Get published gallery photos
 * GET /api/gallery/public
 */
export const getPublicGalleryPhotos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category } = req.query;
    const query: any = { isPublished: true, status: "approved" };

    if (category && category !== "all") {
      query.category = category;
    }

    const photos = await Gallery.find(query)
      .select("title description imageUrl category userName createdAt")
      .sort({ createdAt: -1 })
      .limit(60);

    res.status(200).json({
      success: true,
      photos
    });
  } catch (error: any) {
    logger.error("Get public gallery photos error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to load public gallery", error: error.message });
  }
};

import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import Booking from "../../models/Booking";
import { sanitizeString } from "../../utils/time.utils";
import { sendGHLMediaUploadEvent } from "../../utils/ghl.utils";
import logger from "../../config/logger";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dxx54fccl",
  api_key: process.env.CLOUDINARY_API_KEY || "149937643231624",
  api_secret: process.env.CLOUDINARY_API_SECRET || "whOZPJleA7xJeu_R8kckqq3Lprc"
});

/**
 * Public lookup for the upload page: retrieves booking info so the guest sees their event summary
 * GET /api/bookings/public-upload-info/:idOrCode
 */
export const getBookingUploadInfo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const query = sanitizeString(req.params.idOrCode || req.query.q);
    if (!query) {
      res.status(400).json({ success: false, message: "Booking identifier is required" });
      return;
    }

    let booking = null;
    if (query.match(/^[0-9a-fA-F]{24}$/)) {
      booking = await Booking.findById(query);
    }

    if (!booking) {
      // Try finding by email or phone or short ID
      booking = await Booking.findOne({
        $or: [
          { customerEmail: query.toLowerCase() },
          { customerPhone: query },
          { _id: { $regex: query, $options: "i" } }
        ]
      }).sort({ createdAt: -1 });
    }

    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found. Please check your reservation reference." });
      return;
    }

    const dateStr = booking.bookingDate
      ? booking.bookingDate instanceof Date
        ? booking.bookingDate.toISOString().split("T")[0]
        : String(booking.bookingDate).split("T")[0]
      : "";

    res.status(200).json({
      success: true,
      booking: {
        id: booking._id,
        bookingId: booking._id,
        shortId: String(booking._id).slice(-6).toUpperCase(),
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        bookingDate: dateStr,
        bookingTime: booking.bookingTime,
        eventEndTime: booking.eventEndTime,
        occasion: booking.occasion,
        bookingType: booking.bookingType,
        existingMediaCount: (booking.guestMedia || []).length,
        marketingConsent: Boolean(booking.marketingConsent)
      }
    });
  } catch (error: any) {
    logger.error("[Get Booking Upload Info Error]", error);
    next(new Error("Failed to retrieve booking information"));
  }
};

/**
 * Upload photos and videos from event with marketing consent
 * POST /api/bookings/upload-media
 */
export const uploadGuestEventMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bookingId, mediaList, marketingConsent } = req.body;

    if (!bookingId) {
      res.status(400).json({ success: false, message: "bookingId is required" });
      return;
    }

    if (!Array.isArray(mediaList) || mediaList.length === 0) {
      res.status(400).json({ success: false, message: "Please provide at least one photo or video to upload" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const uploadedEntries: Array<{
      url: string;
      publicId?: string;
      mediaType: "photo" | "video";
      originalName?: string;
      sizeBytes?: number;
      uploadedAt: Date;
    }> = [];

    // Upload each media file to Cloudinary
    for (const item of mediaList) {
      const isVideo = item.mediaType === "video" || item.dataUrl?.startsWith("data:video");
      const resourceType = isVideo ? "video" : "image";

      try {
        const uploadResult = await cloudinary.uploader.upload(item.dataUrl, {
          folder: "tropica_guest_memories",
          resource_type: resourceType,
          transformation: isVideo ? undefined : [
            { width: 1800, crop: "limit" },
            { quality: "auto:good" },
            { fetch_format: "auto" }
          ]
        });

        uploadedEntries.push({
          url: uploadResult.secure_url,
          publicId: uploadResult.public_id,
          mediaType: isVideo ? "video" : "photo",
          originalName: item.originalName || "guest_media",
          sizeBytes: item.sizeBytes || uploadResult.bytes,
          uploadedAt: new Date()
        });
      } catch (uploadErr: any) {
        logger.error("[Media Upload Item Error]", { error: uploadErr.message, filename: item.originalName });
      }
    }

    if (uploadedEntries.length === 0) {
      res.status(500).json({ success: false, message: "Failed to upload media files to storage" });
      return;
    }

    // Append to booking guestMedia
    if (!booking.guestMedia) {
      booking.guestMedia = [];
    }
    booking.guestMedia.push(...uploadedEntries);

    // Save marketing consent
    booking.marketingConsent = Boolean(marketingConsent);
    booking.marketingConsentAt = new Date();

    await booking.save();

    const photoCount = uploadedEntries.filter((m) => m.mediaType === "photo").length;
    const videoCount = uploadedEntries.filter((m) => m.mediaType === "video").length;
    const mediaUrls = uploadedEntries.map((m) => m.url);

    // Send Webhook to GHL
    void sendGHLMediaUploadEvent(booking, {
      mediaUrls,
      photoCount,
      videoCount,
      marketingConsent: Boolean(marketingConsent)
    });

    logger.info(
      `[Guest Media] Saved ${uploadedEntries.length} files for booking #${booking._id} (Marketing Consent: ${
        marketingConsent ? "YES" : "NO"
      })`
    );

    res.status(200).json({
      success: true,
      message: "Media uploaded successfully! Thank you for sharing your memories.",
      uploadedCount: uploadedEntries.length,
      marketingConsent: booking.marketingConsent,
      media: uploadedEntries
    });
  } catch (error: any) {
    logger.error("[Guest Media Upload Error]", error);
    next(new Error(`Failed to upload media: ${error.message}`));
  }
};

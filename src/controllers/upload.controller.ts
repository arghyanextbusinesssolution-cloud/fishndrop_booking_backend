import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";

// Configure Cloudinary explicitly if it's not present in process.env automatically
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dxx54fccl",
  api_key: process.env.CLOUDINARY_API_KEY || "149937643231624",
  api_secret: process.env.CLOUDINARY_API_SECRET || "whOZPJleA7xJeu_R8kckqq3Lprc"
});

export const uploadCakePhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      res.status(400).json({ success: false, message: "No image provided" });
      return;
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: "fishndrop_cakes",
      resource_type: "image"
    });

    res.status(200).json({
      success: true,
      url: result.secure_url
    });
  } catch (error: any) {
    console.error("Cloudinary Upload Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to upload image",
      error: error.message
    });
  }
};

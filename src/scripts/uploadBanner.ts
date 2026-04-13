import "../config/loadEnv";
import { v2 as cloudinary } from "cloudinary";
import path from "path";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadBanner = async () => {
  try {
    const imagePath = path.resolve("C:/Users/saman/.gemini/antigravity/brain/d9a16243-a2e4-44e1-9359-1a4af5bd34ff/fishndrop_email_banner_1776120758443.png");
    console.log(`Uploading ${imagePath}...`);
    
    const result = await cloudinary.uploader.upload(imagePath, {
      folder: "fishndrop_assets",
      public_id: "email_banner",
      overwrite: true,
      resource_type: "image"
    });

    console.log("Upload successful!");
    console.log("Banner URL:", result.secure_url);
    process.exit(0);
  } catch (error) {
    console.error("Upload failed:", error);
    process.exit(1);
  }
};

uploadBanner();

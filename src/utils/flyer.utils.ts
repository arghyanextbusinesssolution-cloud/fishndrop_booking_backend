import { v2 as cloudinary } from "cloudinary";

// Cloudinary credentials are configured once by the upload / event controllers at startup.

/**
 * Accepts an https URL (kept) or an image data URL (uploaded to Cloudinary) and returns the stored URL.
 * Empty input returns "" (no flyer).
 */
export const storeImage = async (raw: unknown, folder: string): Promise<string> => {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (/^https:\/\//i.test(value)) return value.slice(0, 1000);
  const m = value.match(/^data:image\/(?:png|jpe?g|webp|gif|heic|heif);base64,/i);
  if (!m) throw new Error("Unsupported image format");
  if (Math.floor((value.length - m[0].length) * 0.75) > 8 * 1024 * 1024) throw new Error("Image is larger than 8MB");
  const result = await cloudinary.uploader.upload(value, { folder, resource_type: "image" });
  return result.secure_url;
};

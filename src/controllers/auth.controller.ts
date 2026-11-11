import { NextFunction, Request, Response } from "express";
import { isValidDob } from "../utils/dob.utils";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User";
import OtpCode from "../models/OtpCode";
import { sendOtpViaGHL, formatToE164 } from "../services/ghlOtp.service";
import { checkSmsQuota, recordSmsDispatch, getSmsQuotaStatus, clearPhoneSmsAttempts } from "../services/smsLimit.service";
import { sendGHLPromoterRegisteredEvent } from "../integrations/ghl";
import { v2 as cloudinary } from "cloudinary";

const MAX_ID_DOC_BYTES = 10 * 1024 * 1024;

/**
 * Promoter ID documents are stored on Cloudinary; only the https link is saved and sent to GHL.
 * Returns "" when nothing was provided. Throws if an uploaded file can't be stored.
 */
const storeIdDocument = async (raw: unknown): Promise<string> => {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (/^https:\/\//i.test(value)) return value.slice(0, 1000);
  const m = value.match(/^data:(image\/(?:png|jpe?g|webp|heic|heif)|application\/pdf);base64,/i);
  if (!m) throw new Error("Unsupported ID document format");
  if (Math.floor((value.length - m[0].length) * 0.75) > MAX_ID_DOC_BYTES) throw new Error("ID document is larger than 10MB");
  const result = await cloudinary.uploader.upload(value, {
    folder: "tropica_promoter_ids",
    resource_type: "auto"
  });
  return result.secure_url;
};

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

export const getSmsQuota = async (req: Request, res: Response): Promise<void> => {
  try {
    const quota = await getSmsQuotaStatus();
    res.status(200).json({ success: true, quota });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const sendOTP = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({
        success: false,
        message: "Database connection is temporarily unavailable. Please retry in a few moments."
      });
      return;
    }

    const inputPhone = sanitizeString(req.body.phone);
    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();

    if (!inputPhone || inputPhone.replace(/\D/g, "").length < 7) {
      res.status(400).json({ success: false, message: "Valid phone number is required" });
      return;
    }
    const rawPhone = formatToE164(inputPhone);

    // Check SMS Quota & rate limits
    const quotaCheck = await checkSmsQuota(rawPhone);
    if (!quotaCheck.allowed) {
      res.status(429).json({
        success: false,
        message: quotaCheck.error || "SMS limit reached. Please try again later."
      });
      return;
    }

    // 1. Generate a secure 4-digit OTP code (1000 - 9999)
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // Strictly 10 minutes expiry
    const messageTimestamp = new Date();

    console.log(`\n🔑 [4-DIGIT OTP GENERATED] Phone: ${rawPhone} | Code: ${otpCode} | Expires: 10m (${otpExpires.toISOString()})`);

    // 2. Persist / update OTP in OtpCode model (replaces existing OTP if already exists, resets 10-minute expiry)
    await OtpCode.findOneAndUpdate(
      { phone: rawPhone },
      {
        $set: {
          code: otpCode,
          expiresAt: otpExpires,
          timestamp: messageTimestamp
        }
      },
      { upsert: true, returnDocument: "after" }
    );

    // Keep the code on an EXISTING account only. Accounts are created after successful
    // verification (verifyOTP), so requesting a code never leaves an empty "unnamed" user behind.
    await User.updateOne(
      { phone: rawPhone },
      { $set: { otpCode, otpExpires: otpExpires } }
    ).catch((err) => {
      console.warn("User record sync note:", err.message);
    });

    // 3. Dispatch strictly phone number, 4-digit OTP, and message timestamp to GoHighLevel
    const ghlResult = await sendOtpViaGHL({
      phone: rawPhone,
      otp: otpCode
    });

    if (!ghlResult.success && process.env.NODE_ENV === "production") {
      res.status(502).json({
        success: false,
        message: "Failed to dispatch verification code via SMS gateway. Please try again."
      });
      return;
    }

    // 4. Record SMS dispatch for rate limiting
    await recordSmsDispatch(rawPhone, ghlResult.success ? "sent" : "dev_dispatched");

    res.status(200).json({
      success: true,
      message: `4-digit verification code sent via SMS to ${rawPhone}`,
      phone: rawPhone,
      status: "sent",
      ...(process.env.NODE_ENV === "development" ? { devCode: otpCode } : {})
    });
  } catch (error: any) {
    console.error("❌ [Send OTP Error]:", error);
    next(new Error(`Failed to process phone verification: ${error.message}`));
  }
};

export const verifyOTP = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const inputPhone = sanitizeString(req.body.phone);
    const otp = sanitizeString(req.body.otp || req.body.code);
    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();

    if (!inputPhone) {
      res.status(400).json({ success: false, message: "Phone number is required" });
      return;
    }
    if (!otp) {
      res.status(400).json({ success: false, message: "4-digit verification code is required" });
      return;
    }
    const cleanCode = otp.trim();
    const rawPhone = formatToE164(inputPhone);

    console.log(`\n=================== [VERIFY 4-DIGIT OTP START] ===================`);
    console.log(`[TARGET PHONE] : ${rawPhone}`);
    console.log(`[ENTERED CODE] : ${cleanCode}`);

    // Check test code in development mode or master dev fallback
    const isDevTestCode = cleanCode === "1234" && process.env.NODE_ENV === "development";

    // 1. Check against OtpCode collection
    const activeOtpRecord = await OtpCode.findOne({
      phone: rawPhone,
      code: cleanCode,
      expiresAt: { $gt: new Date() }
    });

    // 2. Check against User model
    const existingUser = await User.findOne({ phone: rawPhone }).select("+otpCode +otpExpires");
    const isUserOtpValid =
      existingUser &&
      existingUser.otpCode === cleanCode &&
      existingUser.otpExpires &&
      new Date(existingUser.otpExpires) > new Date();

    const isApproved = Boolean(activeOtpRecord || isUserOtpValid || isDevTestCode);

    if (!isApproved) {
      console.log(`❌ [VERIFY OTP] Invalid or expired code: ${cleanCode}`);
      console.log(`=================== [VERIFY OTP END] ===================\n`);
      res.status(400).json({
        success: false,
        message: "Invalid or expired 4-digit verification code"
      });
      return;
    }

    console.log(`✅ [VERIFY OTP] Code verified successfully!`);
    console.log(`=================== [VERIFY OTP END] ===================\n`);

    // Clean up OTP record from database
    await OtpCode.deleteMany({ phone: rawPhone }).catch(() => {});
    await clearPhoneSmsAttempts(rawPhone);

    const cleanPhone = rawPhone.replace(/\D/g, "");
    const last10 = cleanPhone.slice(-10);

    // Find and update user in database
    let user = existingUser || (await User.findOne({
      $or: [
        { phone: rawPhone },
        { phone: cleanPhone },
        ...(last10.length >= 7 ? [{ phone: { $regex: last10 + "$" } }] : []),
        ...(email ? [{ email }] : [])
      ]
    }));

    if (!user) {
      user = await User.create({
        phone: rawPhone,
        name: (name && name !== "Guest User") ? name : "Guest User",
        email: email || undefined,
        isPhoneVerified: true
      });
    } else {
      user.isPhoneVerified = true;
      user.otpCode = undefined;
      user.otpExpires = undefined;
      if (rawPhone && user.phone !== rawPhone) user.phone = rawPhone;
      // Never overwrite a real name with "Guest User"
      if (name && name !== "Guest User") {
        user.name = name;
      }
      if (email && email.length > 0 && !user.email) user.email = email;
      await user.save();
    }

    // Auto-resolve real name from existing booking if name is still "Guest User" or empty
    if (!user.name || user.name === "Guest User") {
      const Booking = (await import("../models/Booking")).default;
      const bWithRealName = await Booking.findOne({
        $or: [
          { user: user._id },
          ...(last10.length >= 7 ? [{ customerPhone: { $regex: last10 + "$" } }] : [])
        ],
        customerName: { $nin: ["Guest User", "Walk-in Guest", "", null] }
      }).sort({ createdAt: -1 });

      if (bWithRealName && bWithRealName.customerName) {
        user.name = bWithRealName.customerName;
        await user.save();
      }
    }

    // Auto-link any orphan bookings with matching phone to this verified user
    if (last10.length >= 7) {
      const Booking = (await import("../models/Booking")).default;
      await Booking.updateMany(
        {
          $or: [
            { customerPhone: { $regex: last10 + "$" } },
            ...(user.email && !user.email.includes("@fishndrop.com") ? [{ customerEmail: user.email }] : [])
          ],
          user: { $ne: user._id }
        },
        { $set: { user: user._id } }
      ).catch(() => {});
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
      expiresIn: "7d"
    });

    res.status(200).json({
      success: true,
      message: "Phone verified successfully",
      token,
      user: {
        id: user._id,
        name: user.name || "",
        email: user.email || "",
        phone: user.phone,
        role: user.role,
        companyName: user.companyName,
        promoterStatus: user.promoterStatus,
        isPhoneVerified: true
      }
    });
  } catch (error: any) {
    console.error("[Verify OTP Error]:", error);
    next(new Error(`OTP verification failed: ${error.message}`));
  }
};

export const updateProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();
    const phone = sanitizeString(req.body.phone);
    const dobInput = sanitizeString(req.body.dateOfBirth);
    if (dobInput && !isValidDob(dobInput)) {
      res.status(400).json({ success: false, message: "Please enter a valid date of birth" });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    if (email && email !== user.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ success: false, message: "Please enter a valid email address" });
        return;
      }
      const taken = await User.exists({ email, _id: { $ne: user._id } });
      if (taken) {
        res.status(409).json({
          success: false,
          code: "EMAIL_IN_USE",
          message: "This email is already linked to another account. Please use a different email."
        });
        return;
      }
    }

    if (name) user.name = name;
    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (dobInput) user.dateOfBirth = dobInput;
    if (req.body.companyName) user.companyName = sanitizeString(req.body.companyName);
    let newIdDocument = false;
    if (req.body.idDocumentUrl) {
      try {
        const url = await storeIdDocument(req.body.idDocumentUrl);
        if (url && url !== user.idDocumentUrl) {
          user.idDocumentUrl = url;
          newIdDocument = true;
        }
      } catch (err: any) {
        res.status(400).json({ success: false, message: `Could not upload the ID document: ${err.message}` });
        return;
      }
    }

    // A promoter goes back to "pending" only when they submit a NEW ID document for re-verification.
    // (The "promoter_registered" GHL webhook is sent on sign-up only.)
    if (user.role === "promoter" && newIdDocument) {
      user.promoterStatus = "pending";
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: user.role === "promoter" && newIdDocument
        ? "Our employee will verify your data and then we will notify you."
        : "Profile updated successfully",
      user: {
        id: user._id,
        name: user.name || "",
        email: user.email || "",
        phone: user.phone,
        role: user.role,
        companyName: user.companyName,
        idDocumentUrl: user.idDocumentUrl,
        promoterStatus: user.promoterStatus,
        isPhoneVerified: user.isPhoneVerified,
        dateOfBirth: user.dateOfBirth,
        createdAt: (user as any).createdAt
      }
    });
  } catch (error: any) {
    next(new Error("Failed to update profile"));
  }
};

export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();
    const phone = sanitizeString(req.body.phone);
    const password = sanitizeString(req.body.password);

    if (!name) {
      res.status(400).json({ success: false, message: "Name is required" });
      return;
    }

    if (email) {
      const existingUser = await User.findOne({ $or: [{ email }, ...(phone ? [{ phone }] : [])] });
      if (existingUser) {
        res.status(400).json({ success: false, message: "An account with this email address already exists. Please log in instead." });
        return;
      }
    }

    let user;
    if (phone) {
      user = await User.findOne({ phone });
    }

    if (!user) {
      const userData: any = { name, isPhoneVerified: !!phone };
      if (email) userData.email = email;
      if (phone) userData.phone = phone;
      if (password) userData.password = password;
      user = await User.create(userData);
    } else {
      if (name) user.name = name;
      if (email) user.email = email;
      if (password) user.password = password;
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
      expiresIn: "7d"
    });

    res.status(200).json({ 
      success: true, 
      message: "User registered successfully", 
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, companyName: user.companyName, promoterStatus: user.promoterStatus, isPhoneVerified: user.isPhoneVerified }
    });
  } catch (error: any) {
    next(new Error(`Registration failed: ${error.message}`));
  }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = sanitizeString(req.body.email).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password.trim() : "";
    // The login form has one "email or phone" box — anything without an "@" is treated as a phone number
    const isEmail = identifier.includes("@");
    const email = isEmail ? identifier : "";
    const phone = sanitizeString(req.body.phone) || (!isEmail ? identifier : "");

    if (email && password) {
      // Admin / Email user login
      const user = await User.findOne({ email }).select("+password");
      if (!user) {
        res.status(401).json({ success: false, message: "Invalid email or password" });
        return;
      }
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        res.status(401).json({ success: false, message: "Invalid email or password" });
        return;
      }
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
        algorithm: "HS256",
        expiresIn: "7d"
      });
      res.status(200).json({
        success: true,
        token,
        user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, companyName: user.companyName, promoterStatus: user.promoterStatus, isPhoneVerified: user.isPhoneVerified }
      });
      return;
    }

    if (phone && password) {
      // Phone number + password login (password set by the customer or by an admin)
      const digits = phone.replace(/\D/g, "");
      const last10 = digits.slice(-10);
      if (last10.length < 10) {
        res.status(401).json({ success: false, message: "Invalid phone number or password" });
        return;
      }
      const candidates = await User.find({
        $or: [{ phone: formatToE164(phone) }, { phone }, { phone: digits }, { phone: { $regex: last10 + "$" } }]
      })
        .select("+password")
        .limit(5);
      let user = null;
      for (const candidate of candidates) {
        if (await candidate.comparePassword(password)) {
          user = candidate;
          break;
        }
      }
      if (!user) {
        res.status(401).json({ success: false, message: "Invalid phone number or password" });
        return;
      }
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
        algorithm: "HS256",
        expiresIn: "7d"
      });
      res.status(200).json({
        success: true,
        token,
        user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, companyName: user.companyName, promoterStatus: user.promoterStatus, isPhoneVerified: user.isPhoneVerified }
      });
      return;
    }

    res.status(400).json({ success: false, message: "Please provide login credentials" });
  } catch (error) {
    next(new Error("Login failed"));
  }
};

export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    res.status(200).json({ success: true, user: req.user });
  } catch (error) {
    next(new Error("Failed to fetch profile"));
  }
};

export const checkEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const user = await User.findOne({ email });
    res.status(200).json({ success: true, exists: !!user });
  } catch (error) {
    next(new Error("Failed to check email"));
  }
};


export const registerPromoter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // The sign-up flow verifies the phone by OTP first, which signs the person in.
    // We upgrade THAT account, never one looked up by email (that allowed account takeover).
    if (!req.user) {
      res.status(401).json({ success: false, code: "PHONE_VERIFICATION_REQUIRED", message: "Please verify your phone number first" });
      return;
    }

    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();
    const companyName = sanitizeString(req.body.companyName);

    if (!name || name.length < 2) {
      res.status(400).json({ success: false, message: "Please enter your full name" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, message: "Please enter a valid email address" });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(401).json({ success: false, message: "Your session has expired. Please verify your phone again." });
      return;
    }
    if (!user.phone || !user.isPhoneVerified) {
      res.status(403).json({ success: false, code: "PHONE_VERIFICATION_REQUIRED", message: "Please verify your phone number first" });
      return;
    }
    if (["admin", "owner", "staff"].includes(user.role)) {
      res.status(400).json({
        success: false,
        message: "This phone number belongs to a Tropica staff account and can't be registered as a promoter."
      });
      return;
    }
    if (user.role === "promoter") {
      res.status(400).json({
        success: false,
        code: "ALREADY_PROMOTER",
        message: "You already have a promoter account. Please log in."
      });
      return;
    }

    const emailOwner = await User.findOne({ email, _id: { $ne: user._id } }).select("_id").lean();
    if (emailOwner) {
      res.status(409).json({
        success: false,
        code: "EMAIL_IN_USE",
        message: "This email is already used by another account. Please use a different email."
      });
      return;
    }

    let idDocumentUrl = "";
    try {
      idDocumentUrl = await storeIdDocument(req.body.idDocumentUrl);
    } catch (err: any) {
      res.status(400).json({
        success: false,
        code: "ID_UPLOAD_FAILED",
        message: `We couldn't upload your ID document (${err.message}). Please choose the photo again and resubmit.`
      });
      return;
    }

    const isNew = !user.name || user.name === "Guest User";
    user.name = name;
    user.email = email;
    user.role = "promoter";
    user.promoterStatus = "pending";
    if (companyName) user.companyName = companyName;
    if (idDocumentUrl) user.idDocumentUrl = idDocumentUrl;
    await user.save();

    console.log(`\n📝 [PROMOTER APPLICATION] ${name} <${email}> ${user.phone} | ${companyName || "Independent"} | ID: ${idDocumentUrl ? "uploaded" : "none"}\n`);
    void sendGHLPromoterRegisteredEvent(user);

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
      expiresIn: "7d"
    });

    res.status(isNew ? 201 : 200).json({
      success: true,
      message: "Promoter application submitted successfully. Pending staff verification.",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        companyName: user.companyName,
        promoterStatus: user.promoterStatus,
        isPhoneVerified: true,
        stripeConnectOnboarded: user.stripeConnectOnboarded || false
      }
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      res.status(409).json({ success: false, message: "This email or phone is already used by another account." });
      return;
    }
    next(new Error(`Promoter registration failed: ${error.message}`));
  }
};

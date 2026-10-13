import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User";
import OtpCode from "../models/OtpCode";
import { sendOtpViaGHL, formatToE164 } from "../services/ghlOtp.service";
import { checkSmsQuota, recordSmsDispatch, getSmsQuotaStatus, clearPhoneSmsAttempts } from "../services/smsLimit.service";

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

    // Also update/upsert user record
    await User.findOneAndUpdate(
      { phone: rawPhone },
      {
        $set: {
          otpCode,
          otpExpires: otpExpires
        },
        $setOnInsert: { isPhoneVerified: false }
      },
      { upsert: true, returnDocument: "after" }
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

    // Find and update user in database
    let user = existingUser || (await User.findOne({ phone: rawPhone }));
    if (!user) {
      const cleanPhone = rawPhone.replace(/\D/g, "");
      user = await User.findOne({ phone: cleanPhone });
    }

    if (!user) {
      user = await User.create({
        phone: rawPhone,
        name: name || "Guest User",
        email: email || undefined,
        isPhoneVerified: true
      });
    } else {
      user.isPhoneVerified = true;
      user.otpCode = undefined;
      user.otpExpires = undefined;
      if (name) user.name = name;
      if (email && email.length > 0) user.email = email;
      await user.save();
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

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    if (name) user.name = name;
    if (email) user.email = email;

    await user.save();

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: user._id,
        name: user.name || "",
        email: user.email || "",
        phone: user.phone,
        role: user.role
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
      const existingUser = await User.findOne({ email });
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
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
    });
  } catch (error: any) {
    next(new Error(`Registration failed: ${error.message}`));
  }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const email = sanitizeString(req.body.email).toLowerCase();
    const password = sanitizeString(req.body.password);
    const phone = sanitizeString(req.body.phone);

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
        user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
      });
      return;
    }

    if (phone) {
      // Guest phone number login
      const user = await User.findOne({ phone });
      if (!user) {
        res.status(404).json({ success: false, message: "User not found with this phone number" });
        return;
      }
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
        algorithm: "HS256",
        expiresIn: "7d"
      });
      res.status(200).json({
        success: true,
        token,
        user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
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

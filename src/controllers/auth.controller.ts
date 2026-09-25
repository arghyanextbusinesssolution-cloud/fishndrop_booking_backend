import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User";
import { sendVerificationCode, checkVerificationCode } from "../services/twilioVerify.service";
import { checkSmsQuota, recordSmsDispatch, getSmsQuotaStatus } from "../services/smsLimit.service";

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
    const rawPhone = sanitizeString(req.body.phone);
    if (!rawPhone || rawPhone.length < 7) {
      res.status(400).json({ success: false, message: "Valid phone number is required" });
      return;
    }

    // 1. Enforce Daily Cap (50 SMS/day) & Per-Phone Rate Limit (3 requests/15 mins)
    const quota = await checkSmsQuota(rawPhone);
    if (!quota.allowed) {
      res.status(429).json({
        success: false,
        message: quota.error,
        phone: rawPhone,
        remaining: quota.remaining
      });
      return;
    }

    console.log(`\n🔑 [SEND OTP REQUEST] Initiating Twilio Verify for ${rawPhone} (Quota remaining today: ${quota.remaining})...`);

    // Ensure user record exists in MongoDB
    await User.findOneAndUpdate(
      { phone: rawPhone },
      { $setOnInsert: { isPhoneVerified: false } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    const isDev = process.env.NODE_ENV !== "production";

    // Send OTP via Twilio Verify API
    const result = await sendVerificationCode(rawPhone);

    if (!result.success) {
      if (isDev) {
        // Fallback for development while Twilio propagates upgrade or for unverified dev numbers
        const devOtp = "123456";
        await User.findOneAndUpdate(
          { phone: rawPhone },
          { $set: { otpCode: devOtp, otpExpires: new Date(Date.now() + 10 * 60 * 1000) } }
        );
        console.log(`\n🔑 [DEV FALLBACK] Twilio notice: ${result.error}. Dev OTP Code: ${devOtp}`);
        
        // Record dispatch attempt
        await recordSmsDispatch(rawPhone, "dev_fallback");

        res.status(200).json({
          success: true,
          message: `Verification code generated (Dev OTP: ${devOtp})`,
          phone: rawPhone,
          devOtp,
          status: "dev_mode"
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: result.error || "Failed to send verification SMS via Twilio",
        phone: rawPhone
      });
      return;
    }

    // Record live successful SMS dispatch in daily quota
    const updatedQuota = await recordSmsDispatch(rawPhone, "sent");

    res.status(200).json({
      success: true,
      message: "Verification code sent successfully via SMS",
      phone: rawPhone,
      status: result.status,
      quotaRemaining: updatedQuota.remaining
    });
  } catch (error: any) {
    console.error("❌ [Send OTP Error]:", error);
    next(new Error(`Failed to send OTP: ${error.message}`));
  }
};

export const verifyOTP = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawPhone = sanitizeString(req.body.phone);
    const otp = sanitizeString(req.body.otp);
    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();

    if (!rawPhone || !otp) {
      res.status(400).json({ success: false, message: "Phone number and OTP code are required" });
      return;
    }

    const isDev = process.env.NODE_ENV !== "production";
    let approved = false;

    // 1. Check with live Twilio Verify
    const checkResult = await checkVerificationCode(rawPhone, otp);
    if (checkResult.approved) {
      approved = true;
    } else if (isDev) {
      // 2. Fallback check for development mode
      const cleanPhone = rawPhone.replace(/\D/g, "");
      let devUser = await User.findOne({ phone: rawPhone }).select("+otpCode +otpExpires");
      if (!devUser) devUser = await User.findOne({ phone: cleanPhone }).select("+otpCode +otpExpires");

      if (otp === "123456" || (devUser?.otpCode && devUser.otpCode === otp)) {
        console.log(`✅ [DEV OTP VERIFIED] Accepted code ${otp} in local development mode`);
        approved = true;
      }
    }

    if (!approved) {
      res.status(400).json({
        success: false,
        message: checkResult.error || "Invalid or expired verification code. Please try again."
      });
      return;
    }

    // Find and update user in database
    let user = await User.findOne({ phone: rawPhone });
    if (!user) {
      const cleanPhone = rawPhone.replace(/\D/g, "");
      user = await User.findOne({ phone: cleanPhone });
    }

    if (!user) {
      user = await User.create({
        phone: rawPhone,
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

    let user = await User.findOne({ phone });
    if (!user && email) {
      user = await User.findOne({ email });
    }

    if (!user) {
      user = await User.create({ name, email, phone, isPhoneVerified: true });
    } else {
      if (name) user.name = name;
      if (email) user.email = email;
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
      expiresIn: "7d"
    });

    res.status(200).json({ 
      success: true, 
      message: "User registered/updated successfully", 
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
    });
  } catch (error) {
    next(new Error("Registration failed"));
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

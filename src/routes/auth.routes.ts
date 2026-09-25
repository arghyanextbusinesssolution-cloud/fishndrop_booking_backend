import express from "express";
import rateLimit from "express-rate-limit";
import { login, register, getMe, checkEmail, sendOTP, verifyOTP, updateProfile } from "../controllers/auth.controller";
import authMiddleware from "../middleware/auth.middleware";

const authLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later" }
});

const router = express.Router();
router.use(authLimiter);

router.post("/send-otp", sendOTP);
router.post("/verify-otp", verifyOTP);
router.post("/update-profile", authMiddleware, updateProfile);
router.post("/check-email", checkEmail);
router.post("/register", register);
router.post("/login", login);
router.get("/me", authMiddleware, getMe);

export default router;

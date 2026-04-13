import express from "express";
import rateLimit from "express-rate-limit";
import { login, register, getMe, checkEmail } from "../controllers/auth.controller";
import validate from "../middleware/validate.middleware";
import { loginValidator, registerValidator } from "../validators/auth.validator";
import authMiddleware from "../middleware/auth.middleware";

const authLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later" }
});

const router = express.Router();
router.use(authLimiter);

router.post("/check-email", checkEmail);
router.post("/register", registerValidator, validate, register);
router.post("/login", loginValidator, validate, login);
router.get("/me", authMiddleware, getMe);

export default router;

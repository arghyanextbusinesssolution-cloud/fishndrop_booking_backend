import express from "express";
import { createCheckoutSession, handleStripeWebhook, verifyCheckoutSession } from "../controllers/payment.controller";
import authMiddleware from "../middleware/auth.middleware";

const router = express.Router();

// Webhook must be public and handle raw body for signature verification
router.post("/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

// Protected routes - need express.json() manually because they are mounted before the global parser in index.ts
router.post("/checkout-session", express.json(), authMiddleware, createCheckoutSession);
router.post("/verify-session", express.json(), authMiddleware, verifyCheckoutSession);

export default router;

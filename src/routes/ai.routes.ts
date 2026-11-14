import express from "express";
import rateLimit from "express-rate-limit";
import authMiddleware from "../middleware/auth.middleware";
import adminOnly from "../middleware/admin.middleware";
import { startAiHoldWatcher } from "../ai/aiBooking";
import {
  aiBookingStatus,
  availabilityAlternatives,
  availabilityCheck,
  ghlInboundMessage,
  listConversations,
  pauseConversation,
  requireAiSecret,
  resumeConversation,
  staffMessage,
  testChat
} from "../controllers/aiAssistant.controller";

/**
 * Mounted at /api/ai BEFORE the global rate limiter (GHL sends every DM from a few shared IPs),
 * so it has its own, higher limit and its own JSON parser.
 */
const router = express.Router();

router.use(express.json({ limit: "1mb" }));
router.use(express.urlencoded({ extended: false, limit: "1mb" }));
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.AI_RATE_LIMIT_PER_MIN || 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests" }
  })
);

// GHL workflows (secret-protected)
router.post("/ghl/messages", requireAiSecret, ghlInboundMessage);
router.post("/ghl/staff-message", requireAiSecret, staffMessage);
router.post("/ghl/pause", requireAiSecret, pauseConversation);
router.post("/ghl/resume", requireAiSecret, resumeConversation);

// Availability service (secret-protected, used by the AI and for testing)
router.post("/availability/check", requireAiSecret, availabilityCheck);
router.post("/availability/alternatives", requireAiSecret, availabilityAlternatives);

// Testing without GHL
router.post("/test-chat", requireAiSecret, testChat);

// Public: deposit "thank you" page for bookings made in a DM
router.get("/booking/status", aiBookingStatus);

// Admin panel
router.get("/conversations", authMiddleware, adminOnly, listConversations);
router.post("/conversations/:contactId/pause", authMiddleware, adminOnly, pauseConversation);
router.post("/conversations/:contactId/resume", authMiddleware, adminOnly, resumeConversation);

// Booking inside the DM is off unless AI_DM_BOOKING_ENABLED=true. When on, this confirms deposit
// payments every minute and DMs the customer "You're booked!"
if ((process.env.AI_DM_BOOKING_ENABLED || "false").toLowerCase() === "true") startAiHoldWatcher();

export default router;

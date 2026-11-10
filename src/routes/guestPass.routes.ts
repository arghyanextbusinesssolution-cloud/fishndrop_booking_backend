import express from "express";
import {
  getInvitationDetails,
  registerGuestForBooking,
  getBookingGuestPasses,
  updateGuestPassStatus,
  getGuestPassByQrToken,
  getMyCelebrations,
  getMyInvites
} from "../controllers/guestPass.controller";
import authMiddleware from "../middleware/auth.middleware";

const router = express.Router();

// Host: my celebrations (must be before "/:token")
router.get("/my/celebrations", authMiddleware, getMyCelebrations);
router.get("/my/invites", authMiddleware, getMyInvites);

// Public invitation routes (RSVP needs the guest's phone-OTP login)
router.get("/pass/:qrToken", getGuestPassByQrToken);
router.get("/:token", getInvitationDetails);
router.post("/:token/rsvp", authMiddleware, registerGuestForBooking);

// Host protected management
router.get("/booking/:bookingId/guests", authMiddleware, getBookingGuestPasses);
router.patch("/passes/:passId/status", authMiddleware, updateGuestPassStatus);

export default router;


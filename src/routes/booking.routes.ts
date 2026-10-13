import express from "express";
import {
  cancelBooking,
  cancelUnpaidBooking,
  createBooking,
  createBookingWithAccount,
  validateCoupon,
  getAvailability,
  getBookingById,
  getUserBookings,
  getPrivateAvailability,
  createPrivateEventWithAccount,
  getVenueCapacity,
  getPublicBookingStatus,
  updateBookingMenu,
  respondToQuote
} from "../controllers/booking";
import authMiddleware from "../middleware/auth.middleware";
import validate from "../middleware/validate.middleware";
import { createBookingValidator } from "../validators/booking.validator";

import { uploadCakePhoto } from "../controllers/upload.controller";

const router = express.Router();

router.get("/availability", getAvailability);
router.get("/private-availability", getPrivateAvailability);
router.get("/venue-capacity", getVenueCapacity);
router.get("/public-status/:id", getPublicBookingStatus);
router.post("/reserve", createBookingValidator, validate, createBookingWithAccount);
router.post("/reserve-private", createPrivateEventWithAccount);
router.post("/cancel-unpaid", cancelUnpaidBooking);
router.post("/validate-coupon", validateCoupon);
// Public route for uploading cake photos in the booking wizard
router.post("/upload-cake-photo", uploadCakePhoto);

// Booking catering menu & preferences update - accessible for editing booking menu without blocking
router.patch("/:id/menu", updateBookingMenu);
router.patch("/menu/:id", updateBookingMenu);

// Customer quote acceptance or rejection route
router.patch("/:id/quote-response", respondToQuote);
router.patch("/quote/:id", respondToQuote);

router.use(authMiddleware);
router.post("/", createBookingValidator, validate, createBooking);
router.get("/my", getUserBookings);
router.patch("/cancel/:id", cancelBooking);
router.get("/:id", getBookingById);

export default router;

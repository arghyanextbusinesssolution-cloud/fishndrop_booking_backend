import express from "express";
import {
  cancelBooking,
  createBooking,
  createBookingWithAccount,
  validateCoupon,
  getAvailability,
  getBookingById,
  getUserBookings,
  getPrivateAvailability,
  createPrivateEventWithAccount,
  getVenueCapacity
} from "../controllers/booking";
import authMiddleware from "../middleware/auth.middleware";
import validate from "../middleware/validate.middleware";
import { createBookingValidator } from "../validators/booking.validator";

import { uploadCakePhoto } from "../controllers/upload.controller";

const router = express.Router();

router.get("/availability", getAvailability);
router.get("/private-availability", getPrivateAvailability);
router.get("/venue-capacity", getVenueCapacity);
router.post("/reserve", createBookingValidator, validate, createBookingWithAccount);
router.post("/reserve-private", createPrivateEventWithAccount);
router.post("/validate-coupon", validateCoupon);
// Public route for uploading cake photos in the booking wizard
router.post("/upload-cake-photo", uploadCakePhoto);

router.use(authMiddleware);
router.post("/", createBookingValidator, validate, createBooking);
router.get("/my", getUserBookings);
router.get("/:id", getBookingById);
router.patch("/cancel/:id", cancelBooking);

export default router;

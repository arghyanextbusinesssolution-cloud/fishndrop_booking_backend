import express from "express";
import {
  cancelBooking,
  createBooking,
  createBookingWithAccount,
  getAvailability,
  getBookingById,
  getUserBookings
} from "../controllers/booking.controller";
import authMiddleware from "../middleware/auth.middleware";
import validate from "../middleware/validate.middleware";
import { createBookingValidator } from "../validators/booking.validator";

import { uploadCakePhoto } from "../controllers/upload.controller";

const router = express.Router();

router.get("/availability", getAvailability);
router.post("/reserve", createBookingValidator, validate, createBookingWithAccount);
// Public route for uploading cake photos in the booking wizard
router.post("/upload-cake-photo", uploadCakePhoto);

router.use(authMiddleware);
router.post("/", createBookingValidator, validate, createBooking);
router.get("/my", getUserBookings);
router.get("/:id", getBookingById);
router.patch("/cancel/:id", cancelBooking);

export default router;

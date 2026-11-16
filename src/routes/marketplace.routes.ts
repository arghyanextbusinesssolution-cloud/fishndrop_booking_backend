import express from "express";
import { getVenue, getVenueSlots, listVenues } from "../controllers/marketplace/public.controller";
import {
  createBookingRequest,
  getMyBookingRequest,
  getMyBookingRequests,
  createBookingPayment,
  verifyBookingPayment
} from "../controllers/marketplace/booking.controller";
import authMiddleware from "../middleware/auth.middleware";
import { venueOwnerOnly } from "../middleware/admin.middleware";
import * as partner from "../controllers/marketplace/partner.controller";

const router = express.Router();

// Public — Explore Venues + the venue step of the booking wizard
router.get("/venues", listVenues);
router.get("/venues/:slug", getVenue);
router.get("/venues/:slug/slots", getVenueSlots);

// Logged-in customers
router.post("/requests", authMiddleware, createBookingRequest);
router.get("/requests/my", authMiddleware, getMyBookingRequests);
router.get("/requests/:id", authMiddleware, getMyBookingRequest);
router.post("/requests/:id/pay", authMiddleware, createBookingPayment);
router.post("/requests/:id/verify-payment", authMiddleware, verifyBookingPayment);

// Venue owners (partner portal) — every route scoped to the owner's own venue
const owner = express.Router();
owner.use(authMiddleware, venueOwnerOnly);
owner.get("/venue", partner.getMyVenue);
owner.patch("/venue/brand", partner.updateMyBrand);
owner.patch("/venue/hours", partner.updateMyHours);
owner.post("/media", partner.uploadMyMedia);
owner.get("/requests", partner.listMyRequests);
owner.post("/requests/:id/confirm", partner.confirmMyRequest);
owner.post("/requests/:id/decline", partner.declineMyRequest);
owner.get("/bookings", partner.listMyBookings);
owner.get("/payouts", partner.listMyPayouts);
owner.get("/blocks", partner.listMyBlocks);
owner.post("/blocks", partner.createMyBlock);
owner.delete("/blocks/:id", partner.deleteMyBlock);
owner.post("/connect/create-account", partner.createVenueConnectAccount);
owner.post("/connect/onboarding-link", partner.getVenueOnboardingLink);
owner.get("/connect/status", partner.getVenueConnectStatus);
owner.post("/connect/dashboard-link", partner.getVenueDashboardLink);
owner.post("/connect/simulate-onboarding", partner.simulateVenueOnboarding);
owner.post("/connect/disconnect", partner.disconnectVenueStripe);
owner.get("/report", partner.getMyReport);
owner.get("/calendar", partner.getMyCalendar);
router.use("/partner", owner);

export default router;

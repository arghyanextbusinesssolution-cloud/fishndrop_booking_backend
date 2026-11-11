import express from "express";
import {
  createEvent,
  getMyEvents,
  getPromoterDashboardStats,
  getPublicEvents,
  getEventBySlug,
  requestEventApproval,
  adminApproveEvent,
  getAllEventsForAdmin,
  getEventBookings,
  getPromoterBookings,
  getVenueAvailability
} from "../controllers/event.controller";
import authMiddleware from "../middleware/auth.middleware";
import adminOnly, { staffOrAdminOnly } from "../middleware/admin.middleware";
import { promoterOnly } from "../middleware/promoter.middleware";

const router = express.Router();

// Public routes
router.get("/public", getPublicEvents);
router.get("/slug/:slug", getEventBySlug);

// Promoter protected routes
router.use(authMiddleware);
router.post("/", promoterOnly, createEvent);
router.get("/my-events", promoterOnly, getMyEvents);
router.get("/venue-availability", promoterOnly, getVenueAvailability);
router.get("/promoter/dashboard-stats", promoterOnly, getPromoterDashboardStats);
router.get("/promoter/bookings", promoterOnly, getPromoterBookings);
router.patch("/:id/publish-request", promoterOnly, requestEventApproval);

// Admin & Staff review and approval routes
router.get("/admin/all", staffOrAdminOnly, getAllEventsForAdmin);
router.patch("/:id/admin-approve", staffOrAdminOnly, adminApproveEvent);

// Ticket bookings ledger: admin/staff (any event) or owning promoter (checked in controller)
router.get("/:id/bookings", getEventBookings);

export default router;


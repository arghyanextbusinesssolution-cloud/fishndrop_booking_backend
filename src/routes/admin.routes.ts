import express from "express";
import {
  getAllBookings,
  getAllTables,
  getTableStats,
  seedTables,
  setTableAvailability,
  setSlotLock,
  updateTableCounts,
  getSlotLocks,
  getPaymentSummary,
  deleteTable,
  deleteBooking,
  verifyAdminZelleBooking,
  updateBookingOfferPrice,
  createManualBooking,
  lookupCustomer,
  verifyCustomerOtp,
  markBookingFullyPaid,
  getAllUsers,
  deleteUser,
  deleteBulkUsers,
  getPromoters,
  verifyPromoter,
  deletePromoter,
  getEmployees,
  createEmployee,
  deleteEmployee,
  getSystemSettings,
  updateSystemSettings
} from "../controllers/admin.controller";
import { getAdminBookingOverview } from "../controllers/guestPass.controller";
import { getDataCenter, exportDataCenter } from "../controllers/dataCenter.controller";
import { updateBookingMenu, rescheduleBooking } from "../controllers/booking";
import adminOnly, { staffOrAdminOnly } from "../middleware/admin.middleware";
import authMiddleware from "../middleware/auth.middleware";
import couponRoutes from "./coupon.routes";

const router = express.Router();

router.use(authMiddleware, staffOrAdminOnly);
router.post("/seed-tables", adminOnly, seedTables);
router.get("/tables", getAllTables);
router.patch("/tables/config", adminOnly, updateTableCounts);
router.patch("/tables/:id/availability", setTableAvailability);
router.delete("/tables/:id", adminOnly, deleteTable);
router.patch("/slots/lock", setSlotLock);
router.get("/slot-locks", getSlotLocks);
router.get("/bookings", getAllBookings);
router.post("/bookings/manual", createManualBooking);
router.get("/customers/lookup", lookupCustomer);
router.post("/customers/verify-otp", verifyCustomerOtp);

// User management routes
router.get("/users", getAllUsers);
router.delete("/users/:id", adminOnly, deleteUser);
router.post("/users/bulk-delete", adminOnly, deleteBulkUsers);

// Promoter verification routes (Staff & Admin can view and verify)
router.get("/promoters", getPromoters);
router.patch("/promoters/:id/verify", verifyPromoter);
router.delete("/promoters/:id", adminOnly, deletePromoter);

// Employee / Staff account management (Admin & Owner only)
router.get("/employees", adminOnly, getEmployees);
router.post("/employees", adminOnly, createEmployee);
router.delete("/employees/:id", adminOnly, deleteEmployee);

// Pricing and platform fee configuration
router.get("/settings/pricing", getSystemSettings);
router.patch("/settings/pricing", adminOnly, updateSystemSettings);

router.get("/bookings/:id/overview", getAdminBookingOverview);

// Data Center: customer contacts for marketing (admin / owner only)
router.get("/data-center", adminOnly, getDataCenter);
router.get("/data-center/export", adminOnly, exportDataCenter);
router.patch("/bookings/:id/verify-zelle", verifyAdminZelleBooking);
router.patch("/bookings/:id/mark-paid", markBookingFullyPaid);
router.patch("/bookings/:id/offer", updateBookingOfferPrice);
router.patch("/bookings/:id/menu", updateBookingMenu);
router.patch("/bookings/:id/reschedule", rescheduleBooking);
router.delete("/bookings/:id", deleteBooking);
router.get("/stats", getTableStats);
router.get("/payments/summary", getPaymentSummary);

// Mount coupon routes
router.use("/coupons", couponRoutes);

export default router;

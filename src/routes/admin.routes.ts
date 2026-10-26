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
  markBookingFullyPaid,
  getAllUsers,
  deleteUser,
  deleteBulkUsers
} from "../controllers/admin.controller";
import { updateBookingMenu } from "../controllers/booking";
import adminOnly from "../middleware/admin.middleware";
import authMiddleware from "../middleware/auth.middleware";
import couponRoutes from "./coupon.routes";

const router = express.Router();

router.use(authMiddleware, adminOnly);
router.post("/seed-tables", seedTables);
router.get("/tables", getAllTables);
router.patch("/tables/config", updateTableCounts);
router.patch("/tables/:id/availability", setTableAvailability);
router.delete("/tables/:id", deleteTable);
router.patch("/slots/lock", setSlotLock);
router.get("/slot-locks", getSlotLocks);
router.get("/bookings", getAllBookings);
router.post("/bookings/manual", createManualBooking);
router.get("/customers/lookup", lookupCustomer);

// User management routes
router.get("/users", getAllUsers);
router.delete("/users/:id", deleteUser);
router.post("/users/bulk-delete", deleteBulkUsers);

router.patch("/bookings/:id/verify-zelle", verifyAdminZelleBooking);
router.patch("/bookings/:id/mark-paid", markBookingFullyPaid);
router.patch("/bookings/:id/offer", updateBookingOfferPrice);
router.patch("/bookings/:id/menu", updateBookingMenu);
router.delete("/bookings/:id", deleteBooking);
router.get("/stats", getTableStats);
router.get("/payments/summary", getPaymentSummary);

// Mount coupon routes
router.use("/coupons", couponRoutes);

export default router;

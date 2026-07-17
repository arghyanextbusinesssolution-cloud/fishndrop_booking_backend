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
  deleteBooking
} from "../controllers/admin.controller";
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
router.delete("/bookings/:id", deleteBooking);
router.get("/stats", getTableStats);
router.get("/payments/summary", getPaymentSummary);

// Mount coupon routes
router.use("/coupons", couponRoutes);

export default router;

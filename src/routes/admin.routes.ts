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
  deleteTable
} from "../controllers/admin.controller";
import adminOnly from "../middleware/admin.middleware";
import authMiddleware from "../middleware/auth.middleware";

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
router.get("/stats", getTableStats);
router.get("/payments/summary", getPaymentSummary);

export default router;

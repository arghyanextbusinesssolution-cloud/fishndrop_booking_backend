import express from "express";
import {
  getAllBookings,
  getAllTables,
  getTableStats,
  seedTables,
  setTableAvailability,
  setSlotLock,
  updateTableCounts
} from "../controllers/admin.controller";
import adminOnly from "../middleware/admin.middleware";
import authMiddleware from "../middleware/auth.middleware";

const router = express.Router();

router.use(authMiddleware, adminOnly);
router.post("/seed-tables", seedTables);
router.get("/tables", getAllTables);
router.patch("/tables/config", updateTableCounts);
router.patch("/tables/:id/availability", setTableAvailability);
router.patch("/slots/lock", setSlotLock);
router.get("/bookings", getAllBookings);
router.get("/stats", getTableStats);

export default router;

import express from "express";
import {
  createVenueWithOwner,
  deletePartnerVenue,
  getExternalRevenue,
  getVenueRevenue,
  settleVenuePayout,
  getPartnerVenue,
  listPartnerVenues,
  resetVenueOwnerPassword,
  setVenueCommission,
  updatePartnerVenue,
  uploadVenueMedia
} from "../controllers/marketplace/admin.controller";
import adminOnly, { staffOrAdminOnly } from "../middleware/admin.middleware";
import authMiddleware from "../middleware/auth.middleware";

/** /api/admin/marketplace — Sarah/employees manage venue owners; admins set commission. */
const router = express.Router();
router.use(authMiddleware, staffOrAdminOnly);

router.get("/venues", listPartnerVenues);
router.post("/venues", createVenueWithOwner);
router.get("/venues/:id", getPartnerVenue);
router.patch("/venues/:id", updatePartnerVenue);
router.delete("/venues/:id", adminOnly, deletePartnerVenue);
router.patch("/venues/:id/commission", adminOnly, setVenueCommission);
router.post("/venues/:id/owner/reset-password", resetVenueOwnerPassword);
router.post("/media", uploadVenueMedia);
// Money reports are for admins/owners only (like Financials)
router.get("/revenue", adminOnly, getExternalRevenue);
router.get("/revenue/:id", adminOnly, getVenueRevenue);
router.post("/bookings/:id/settle", adminOnly, settleVenuePayout);

export default router;

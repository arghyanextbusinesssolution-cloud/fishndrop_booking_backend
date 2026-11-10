import express from "express";
import {
  createTicketCheckout,
  verifyTicketOrder,
  getTicketByQrToken,
  cancelTicketOrder,
  getMyTickets,
  getGroupPass
} from "../controllers/ticketPurchase.controller";
import {
  getShareInvite,
  claimSharedSeat,
  decideSeatRequest,
  assignSeat,
  cancelMySeat,
  getLiveQr
} from "../controllers/ticketShare.controller";
import authMiddleware from "../middleware/auth.middleware";

const router = express.Router();

// Buyer must be signed in with an OTP-verified phone number
router.post("/checkout", authMiddleware, createTicketCheckout);
router.post("/cancel-order", authMiddleware, cancelTicketOrder);
router.get("/my", authMiddleware, getMyTickets);
router.get("/group/:token", getGroupPass); // legacy group passes only

// Guest sharing: buyer shares one link, guests claim with phone OTP, buyer accepts/rejects
router.get("/share/:token", getShareInvite);
router.post("/share/:token/claim", authMiddleware, claimSharedSeat);
router.patch("/seats/:ticketId/holder", authMiddleware, decideSeatRequest);
router.post("/seats/:ticketId/assign", authMiddleware, assignSeat);
router.post("/seats/:ticketId/cancel", authMiddleware, cancelMySeat);
router.get("/seats/:ticketId/live-qr", authMiddleware, getLiveQr);
router.post("/verify-order", verifyTicketOrder);
router.get("/qr/:qrToken", getTicketByQrToken);

export default router;

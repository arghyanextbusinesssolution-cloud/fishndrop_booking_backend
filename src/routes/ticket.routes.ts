import express from "express";
import {
  createTicketCheckout,
  verifyTicketOrder,
  getTicketByQrToken,
  cancelTicketOrder,
  getMyTickets,
  setOrderQrMode,
  getGroupPass
} from "../controllers/ticketPurchase.controller";
import authMiddleware from "../middleware/auth.middleware";

const router = express.Router();

// Buyer must be signed in with an OTP-verified phone number
router.post("/checkout", authMiddleware, createTicketCheckout);
router.post("/cancel-order", authMiddleware, cancelTicketOrder);
router.get("/my", authMiddleware, getMyTickets);
router.post("/orders/:orderId/qr-mode", authMiddleware, setOrderQrMode);
router.get("/group/:token", getGroupPass);
router.post("/verify-order", verifyTicketOrder);
router.get("/qr/:qrToken", getTicketByQrToken);

export default router;

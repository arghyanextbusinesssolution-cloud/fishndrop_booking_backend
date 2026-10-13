import express, { NextFunction, Request, Response } from "express";
import authMiddleware from "../middleware/auth.middleware";
import {
  getFinancialStats,
  getUpcomingPayments,
  getEventProfitability,
  getVendorPayables,
  markVendorPaymentPaid,
  getRefundsAndCancellations
} from "../controllers/financials.controller";

const router = express.Router();

/**
 * Strict owner/admin role verification middleware.
 * Sarah and general staff members are strictly denied access to full financials.
 */
export const ownerOrAdminFinancialsOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const userRole = (req.user.role || "").toLowerCase();
  const userName = (req.user.name || "").toLowerCase();
  const userEmail = (req.user.email || "").toLowerCase();

  // Strict check: Block Sarah and any staff roles from viewing platform financials
  if (userRole === "staff" || userName.includes("sarah") || userEmail.includes("sarah")) {
    res.status(403).json({
      success: false,
      message: "Forbidden: Staff members do not have permission to access financial reporting."
    });
    return;
  }

  if (userRole !== "admin" && userRole !== "owner") {
    res.status(403).json({
      success: false,
      message: "Forbidden: Owner or Super Admin access required."
    });
    return;
  }

  next();
};

router.use(authMiddleware, ownerOrAdminFinancialsOnly);

router.get("/stats", getFinancialStats);
router.get("/upcoming-payments", getUpcomingPayments);
router.get("/profitability", getEventProfitability);
router.get("/vendor-payables", getVendorPayables);
router.patch("/vendor-payables/:bookingId/pay", markVendorPaymentPaid);
router.get("/refunds", getRefundsAndCancellations);

export default router;

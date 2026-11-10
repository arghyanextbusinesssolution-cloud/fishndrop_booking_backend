import express from "express";
import { scanTicket, searchTickets } from "../controllers/checkin.controller";
import authMiddleware from "../middleware/auth.middleware";
import { NextFunction, Request, Response } from "express";

const router = express.Router();

// Staff/admin/owner can check in anything; promoters only tickets for their own events
// (ownership enforced inside the controller).
const doorRoles = (req: Request, res: Response, next: NextFunction): void => {
  const role = req.user?.role;
  if (role === "admin" || role === "owner" || role === "staff" || role === "promoter") return next();
  res.status(403).json({ success: false, message: "Forbidden: door check-in access required." });
};

router.use(authMiddleware, doorRoles);
router.post("/scan", scanTicket);
router.get("/search", searchTickets);

export default router;


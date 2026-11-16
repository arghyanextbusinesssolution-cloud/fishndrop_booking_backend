import express, { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import authMiddleware from "../middleware/auth.middleware";
import { autocompletePlaces, placeDetails } from "../controllers/places.controller";

const router = express.Router();

// Promoters (event venues), staff/admins (partner venue profiles) and venue owners only.
// Rate limited: each keystroke batch hits a paid/fair-use API.
const PLACES_ROLES = ["promoter", "admin", "owner", "staff", "venue_owner"];
const placesAccess = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user || !PLACES_ROLES.includes(req.user.role)) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }
  next();
};

router.use(
  authMiddleware,
  placesAccess,
  rateLimit({ windowMs: 60_000, max: 90, standardHeaders: true, legacyHeaders: false })
);
router.get("/autocomplete", autocompletePlaces);
router.get("/details", placeDetails);

export default router;

import express from "express";
import rateLimit from "express-rate-limit";
import authMiddleware from "../middleware/auth.middleware";
import { promoterOnly } from "../middleware/promoter.middleware";
import { autocompletePlaces, placeDetails } from "../controllers/places.controller";

const router = express.Router();

// Signed-in promoters/admins only, rate limited (each keystroke batch hits a paid/fair-use API)
router.use(
  authMiddleware,
  promoterOnly,
  rateLimit({ windowMs: 60_000, max: 90, standardHeaders: true, legacyHeaders: false })
);
router.get("/autocomplete", autocompletePlaces);
router.get("/details", placeDetails);

export default router;

import express from "express";
import { ghlQuoteUpdateWebhook } from "../controllers/ghlWebhook.controller";

const router = express.Router();

/**
 * POST /api/webhooks/ghl/quote-update
 * Inbound GHL webhook for quote acceptance / rejection.
 * No auth required — GHL calls this from their automation workflow.
 */
router.post("/ghl/quote-update", ghlQuoteUpdateWebhook);

export default router;

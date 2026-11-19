import express, { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import logger from "../config/logger";
import { dispatchToGHL } from "../integrations/ghl/client";
import { sanitizeString } from "../utils/time.utils";

/**
 * POST /api/inquiries — quick inquiry from the homepage assistant bubble.
 * Public (no login). Sends a "website_inquiry" lead to GHL (general lead webhook) so the team follows up.
 * body: { name, phone, email?, eventDate?, guests?, interest?, message?, website (honeypot) }
 */
const router = express.Router();

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many inquiries — please call us at 1-866-990-7422." }
  })
);

const toE164 = (raw: string): string | null => {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (raw.trim().startsWith("+") && d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
};

const INTERESTS = new Set(["venue", "walkthrough", "catering", "event", "other"]);

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = req.body || {};
    // Honeypot: real visitors never fill the hidden "website" field
    if (sanitizeString(b.website)) {
      res.json({ success: true });
      return;
    }
    const name = sanitizeString(b.name).slice(0, 80);
    const phone = toE164(sanitizeString(b.phone));
    const emailRaw = sanitizeString(b.email).toLowerCase().slice(0, 120);
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw) ? emailRaw : "";
    if (!name || !phone) {
      res.status(400).json({ success: false, message: "Please add your name and a valid phone number." });
      return;
    }
    const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(sanitizeString(b.eventDate)) ? sanitizeString(b.eventDate) : "";
    const guests = Math.min(5000, Math.max(0, Math.round(Number(b.guests) || 0)));
    const interest = INTERESTS.has(sanitizeString(b.interest)) ? sanitizeString(b.interest) : "venue";
    const message = sanitizeString(b.message).slice(0, 1000);
    const [firstName, ...rest] = name.split(/\s+/);

    const payload = {
      event: "website_inquiry",
      source: "website_assistant",
      sentAt: new Date().toISOString(),
      name,
      firstName,
      lastName: rest.join(" "),
      phone,
      email,
      interest,
      eventDate,
      guests: guests || "",
      message,
      page: sanitizeString(b.page).slice(0, 200),
      summary: `Website inquiry (${interest}) from ${name} ${phone}${eventDate ? ` · event ${eventDate}` : ""}${guests ? ` · ${guests} guests` : ""}${message ? ` — "${message}"` : ""}`
    };

    const r = await dispatchToGHL({ webhook: "general", event: "website_inquiry", ref: phone.slice(-6), payload }).catch(() => undefined);
    if (!r?.ok) {
      logger.error("[INQUIRY] GHL webhook failed", { status: r?.status, phone: phone.slice(-4) });
      res.status(502).json({ success: false, message: "We couldn't send that right now — please call us at 1-866-990-7422." });
      return;
    }
    logger.info("[INQUIRY] website inquiry sent", { interest, guests, hasDate: Boolean(eventDate) });
    res.json({ success: true, message: "Thanks! Our team will reach out shortly." });
  } catch (err) {
    next(err);
  }
});

export default router;

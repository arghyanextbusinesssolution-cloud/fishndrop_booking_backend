import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import logger from "../config/logger";
import AiConversation from "../models/AiConversation";
import { processInboundMessage, recordStaffMessage, setAiPaused } from "../ai/assistant.service";
import { checkTableAvailability, checkVenueAvailability, findOpenVenueDates } from "../ai/availability";
import { hasGhlApi, sendReplyToWebhook, sendSocialReply } from "../ai/ghlMessaging";
import { bookingRef, checkAiHoldPayment } from "../ai/aiBooking";
import Booking from "../models/Booking";

/**
 * Tropica AI booking assistant endpoints.
 *
 * GHL → POST /api/ai/ghl/messages  (Custom Webhook from the "Customer Replied" workflow)
 *   Auth: header "x-tropica-ai-secret: <AI_WEBHOOK_SECRET>" or "?secret=<AI_WEBHOOK_SECRET>".
 *   Reply delivery (AI_REPLY_MODE or ?mode=):
 *     - "webhook" (default) → answer 200 at once, then POST the reply to the GHL AI-reply webhook
 *                             (GHL_AI_REPLY_WEBHOOK_URL); that workflow sends it to the customer.
 *     - "api"               → post the reply into the IG/FB chat via the GHL API (needs GHL_API_TOKEN).
 *     - "response"          → wait and return { reply } in this HTTP response.
 */

const secretOk = (req: Request): boolean => {
  const expected = process.env.AI_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  const given = String(req.headers["x-tropica-ai-secret"] || req.query.secret || req.body?.secret || "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const requireAiSecret = (req: Request, res: Response, next: NextFunction) => {
  if (!secretOk(req)) {
    res.status(401).json({ success: false, message: "Invalid or missing AI webhook secret" });
    return;
  }
  next();
};

const pick = (...vals: unknown[]): string => {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
};

/** Accepts both a hand-built Custom Webhook body and GHL's standard workflow webhook payload. */
const parseInbound = (body: any) => {
  const msg = typeof body.message === "object" && body.message ? body.message : {};
  const custom = body.customData || body.custom_data || {};
  const contactId = pick(body.contactId, body.contact_id, custom.contactId, body.contact?.id);
  const text = pick(typeof body.message === "string" ? body.message : "", msg.body, body.body, body.text, custom.message);
  const rawChannel = pick(body.channel, custom.channel, msg.type, body.messageType, body.type, body.source).toLowerCase();
  const channel = /insta|^ig$|type_instagram/.test(rawChannel)
    ? "instagram"
    : /face|messenger|^fb$|type_facebook/.test(rawChannel)
      ? "facebook"
      : rawChannel || "instagram";
  const direction = pick(body.direction, msg.direction, custom.direction).toLowerCase();
  return {
    contactId,
    text,
    channel,
    direction,
    messageId: pick(body.messageId, body.message_id, msg.id, custom.messageId),
    contactEmail: pick(body.email, body.contactEmail, custom.email, body.contact?.email),
    contactPhone: pick(body.phone, body.contactPhone, custom.phone, body.contact?.phone),
    contactName: pick(body.contactName, body.full_name, body.name, custom.contactName, [body.first_name, body.last_name].filter(Boolean).join(" "))
  };
};

export const ghlInboundMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    console.log("\n[AI] ⬇️  INCOMING from GHL webhook:");
    console.log(JSON.stringify(req.body, null, 2));
    const m = parseInbound(req.body || {});
    console.log("[AI] Parsed message:", JSON.stringify(m));
    if (!m.contactId || !m.text) {
      res.status(400).json({ success: false, message: "contactId and message text are required" });
      return;
    }
    if (m.direction === "outbound") {
      res.json({ success: true, status: "ignored", reply: null });
      return;
    }

    const mode = String(req.query.mode || process.env.AI_REPLY_MODE || "webhook").toLowerCase();
    if (mode === "webhook" || (mode === "api" && hasGhlApi())) {
      res.json({ success: true, status: "accepted" });
      processInboundMessage(m)
        .then(async (r) => {
          let delivered = false;
          if (r.reply) {
            delivered =
              mode === "api"
                ? await sendSocialReply(m.contactId, m.channel, r.reply)
                : await sendReplyToWebhook({
                    contactId: m.contactId,
                    channel: m.channel,
                    contactName: m.contactName,
                    reply: r.reply,
                    stage: r.stage,
                    handoff: r.handoff,
                    inboundMessage: m.text
                  });
          }
          console.log(`[AI] 🤖 AI result → status=${r.status} stage=${r.stage} tools=${(r.toolsUsed || []).join(",") || "-"} handoff=${r.handoff}`);
          console.log(`[AI] 💬 Reply: ${r.reply ?? "(no reply — " + r.status + ")"}`);
          console.log(`[AI] Delivered to GHL: ${delivered ? "YES" : "NO"} (mode=${mode})\n`);
          logger.info("[AI] handled", { contactId: m.contactId, status: r.status, stage: r.stage, tools: r.toolsUsed, delivered, mode });
        })
        .catch((err) => logger.error("[AI] async handle failed", { error: err?.message }));
      return;
    }

    const r = await processInboundMessage(m);
    logger.info("[AI] handled", { contactId: m.contactId, status: r.status, stage: r.stage, tools: r.toolsUsed });
    res.json({ success: true, ...r, reply: r.reply || "", hasReply: Boolean(r.reply) });
  } catch (err) {
    next(err);
  }
};

/** Quick test without GHL: POST /api/ai/test-chat { message, contactId?, channel? } */
export const testChat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const message = pick(req.body?.message);
    if (!message) {
      res.status(400).json({ success: false, message: "message is required" });
      return;
    }
    const contactId = pick(req.body?.contactId) || "test-contact";
    const r = await processInboundMessage({
      contactId,
      channel: pick(req.body?.channel) || "instagram",
      text: message,
      contactName: pick(req.body?.name) || "Test Customer",
      messageId: crypto.randomUUID()
    });
    const conv = await AiConversation.findOne({ contactId }).lean();
    res.json({ success: true, ...r, inquiry: conv?.inquiry, lastCheck: conv?.lastCheck });
  } catch (err) {
    next(err);
  }
};

export const availabilityCheck = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kind = req.body?.type === "table" ? "table" : "venue";
    res.json(kind === "table" ? await checkTableAvailability(req.body) : await checkVenueAvailability(req.body));
  } catch (err) {
    next(err);
  }
};

export const availabilityAlternatives = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await findOpenVenueDates(req.body || {}));
  } catch (err) {
    next(err);
  }
};

/** Staff takeover from a GHL workflow (e.g. tag "AI Paused" added) or admin panel. */
export const pauseConversation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contactId = pick(req.params.contactId as string, req.body?.contactId, req.body?.contact_id);
    if (!contactId) {
      res.status(400).json({ success: false, message: "contactId is required" });
      return;
    }
    const by = (req as any).user?.name || pick(req.body?.by) || "staff";
    const conv = await setAiPaused(contactId, true, by, pick(req.body?.reason));
    res.json({ success: true, aiPaused: true, stage: conv?.stage });
  } catch (err) {
    next(err);
  }
};

export const resumeConversation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contactId = pick(req.params.contactId as string, req.body?.contactId, req.body?.contact_id);
    if (!contactId) {
      res.status(400).json({ success: false, message: "contactId is required" });
      return;
    }
    const conv = await setAiPaused(contactId, false);
    res.json({ success: true, aiPaused: false, found: Boolean(conv) });
  } catch (err) {
    next(err);
  }
};

/** GHL "staff sent a message" → keep it in the AI's memory. */
export const staffMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const m = parseInbound(req.body || {});
    if (m.contactId && m.text) await recordStaffMessage(m.contactId, m.text);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

/**
 * Public: the "payment received" page after the Stripe deposit link (customer isn't logged in).
 * Settles the hold (confirms if Stripe says paid) and returns only non-sensitive booking info.
 */
export const aiBookingStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bookingId = pick(req.query.bookingId as string, req.body?.bookingId);
    const sessionId = pick(req.query.session_id as string, req.body?.sessionId);
    if (!/^[a-f0-9]{24}$/i.test(bookingId)) {
      res.status(400).json({ success: false, message: "Invalid booking" });
      return;
    }
    const booking: any = await Booking.findById(bookingId).select(
      "aiStripeSessionId bookingDate bookingTime durationHours partySize depositAmount totalAmount remainingAmount status customerName"
    );
    // Only AI DM bookings, and only with the matching Stripe session (or the cancel return)
    if (!booking?.aiStripeSessionId || (sessionId && sessionId !== booking.aiStripeSessionId)) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    const status = await checkAiHoldPayment(bookingId, { notifyCustomer: true });
    res.json({
      success: true,
      status,
      ref: bookingRef(booking._id),
      firstName: String(booking.customerName || "").split(" ")[0],
      date: booking.bookingDate.toISOString().slice(0, 10),
      time: booking.bookingTime,
      durationHours: booking.durationHours,
      guests: booking.partySize,
      total: booking.totalAmount,
      deposit: booking.depositAmount,
      balance: booking.remainingAmount
    });
  } catch (err) {
    next(err);
  }
};

export const listConversations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const filter: Record<string, unknown> = {};
    if (req.query.paused === "true") filter.aiPaused = true;
    const items = await AiConversation.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("-processedMessageIds")
      .lean();
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
};

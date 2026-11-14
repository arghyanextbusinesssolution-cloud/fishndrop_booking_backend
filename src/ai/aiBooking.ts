import crypto from "crypto";
import logger from "../config/logger";
import Booking from "../models/Booking";
import User from "../models/User";
import Table from "../models/Table";
import SlotLock from "../models/SlotLock";
import AiConversation from "../models/AiConversation";
import { createSlotLocksForPrivateEvent, isPrivateSlotAvailable } from "../services/booking/private.service";
import { buildDayRange } from "../utils/time.utils";
import { getFrontendBaseUrl } from "../utils/siteUrl";
import { calculateEventTimes, sendGHLBookingEvent } from "../integrations/ghl";
import { claimFirstConfirmation, computeChargeAmount, getStripe } from "../controllers/payment.controller";
import {
  sendFullPaymentConfirmationViaEmailJS,
  sendPaymentEmails,
  sendRemainingBalanceReminderViaEmailJS
} from "../utils/email.utils";
import { getPricing, MAX_DURATION, MIN_DURATION, MIN_VENUE_GUESTS } from "./knowledge";
import { priceQuote } from "./availability";
import { endTime, isValidYmd, normalizeTime, nyToday, prettyDate, to12h } from "./dates";
import { deliverReply } from "./ghlMessaging";

/**
 * Booking from a DM: the AI creates a real pending private-venue booking (same fields as the website),
 * locks the slot, and sends a Stripe deposit link. The slot is held until the link expires
 * (AI_HOLD_MINUTES, min 30 = Stripe's minimum). Paying confirms the booking — through the Stripe
 * webhook in production, or through checkAiHoldPayment (watcher / next message / thank-you page).
 */

const HOLD_MINUTES = Math.max(30, Number(process.env.AI_HOLD_MINUTES) || 30);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const bookingRef = (id: unknown) => String(id).slice(-6).toUpperCase();

export interface HoldRequest {
  contactId: string;
  channel: string;
  fullName?: string;
  email?: string;
  phone?: string;
  date?: string;
  startTime?: string;
  durationHours?: number;
  guests?: number;
  occasion?: string;
  dj?: boolean;
  photographer?: boolean;
  photographerHours?: number;
}

/** Releases a hold the customer no longer wants (or replaced). Never touches paid bookings. */
export const cancelAiHold = async (bookingId: string, reason: string) => {
  const b = await Booking.findById(bookingId);
  if (!b || b.status !== "pending" || b.paymentStatus !== "pending_payment") return false;
  await SlotLock.deleteMany({ eventId: b._id });
  b.status = "cancelled";
  b.aiHoldExpiresAt = undefined;
  b.notes = `${b.notes || ""}\n[AI] Hold released: ${reason}`.trim();
  await b.save();
  const stripe = getStripe();
  if (stripe && b.aiStripeSessionId) {
    await stripe.checkout.sessions.expire(b.aiStripeSessionId).catch(() => undefined);
  }
  await AiConversation.updateOne({ contactId: b.aiContactId, "hold.bookingId": String(b._id) }, { $set: { "hold.status": "cancelled" } });
  return true;
};

export const createAiVenueHold = async (r: HoldRequest) => {
  // ---- validate everything before touching the database
  const missing: string[] = [];
  const name = (r.fullName || "").trim().replace(/\s+/g, " ");
  const email = (r.email || "").trim().toLowerCase();
  const phoneDigits = (r.phone || "").replace(/\D/g, "");
  const time = normalizeTime(r.startTime);
  if (name.split(" ").length < 2) missing.push("full name (first and last)");
  if (!EMAIL_RE.test(email)) missing.push("email");
  if (phoneDigits.length < 10) missing.push("phone number");
  if (!isValidYmd(r.date) || r.date < nyToday()) missing.push("a valid future date");
  if (!time) missing.push("start time");
  if (!r.guests) missing.push("number of guests");
  if (missing.length) return { ok: false, error: `Missing or invalid: ${missing.join(", ")}`, missing };

  const date = r.date as string;
  const startTime = time as string;
  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(Number(r.durationHours) || 5)));
  const guests = Math.round(Number(r.guests));
  const pricing = await getPricing();
  if (guests < MIN_VENUE_GUESTS) return { ok: false, error: `Private buyouts need at least ${MIN_VENUE_GUESTS} guests.` };
  if (guests > pricing.maxGuestCapacity) return { ok: false, error: `Maximum capacity is ${pricing.maxGuestCapacity} guests.` };

  const stripe = getStripe();
  if (!stripe) return { ok: false, error: "Online payments are not configured — share the website booking link instead." };

  // One active hold per chat: replace the previous one
  const conv = await AiConversation.findOne({ contactId: r.contactId });
  if (conv?.hold?.bookingId && conv.hold.status === "awaiting_payment") {
    await cancelAiHold(conv.hold.bookingId, "Customer changed the booking details");
  }

  // Final live check right before locking
  if (!(await isPrivateSlotAvailable(date, startTime, duration))) {
    return { ok: false, error: `${prettyDate(date)} ${to12h(startTime)} for ${duration}h was just taken — check other times.` };
  }

  // ---- customer account (same matching as the website: phone, then email)
  const phone = phoneDigits.length === 10 ? `+1${phoneDigits}` : `+${phoneDigits}`;
  let user =
    (await User.findOne({ phone })) ||
    (await User.findOne({ phone: phoneDigits })) ||
    (await User.findOne({ email }));
  if (!user) {
    user = await User.create({ name, email, phone, role: "user" });
  } else {
    let dirty = false;
    if (!user.name || user.name === "Guest User") { user.name = name; dirty = true; }
    if (!user.email) { user.email = email; dirty = true; }
    if (!user.phone) { user.phone = phone; dirty = true; }
    if (dirty) await user.save();
  }

  // ---- price exactly like the website (no coupon from DMs)
  const q = priceQuote(pricing, guests, duration, Boolean(r.dj), Boolean(r.photographer), Math.max(2, Number(r.photographerHours) || 2));
  const deposit = Math.min(q.total, pricing.minDepositAmount);
  const remaining = q.total - deposit;
  const { parsedDate } = buildDayRange(date);
  const { eventEndTime } = calculateEventTimes(date, startTime, duration);
  const allTables = await Table.find().select("_id");
  const holdUntil = new Date(Date.now() + (HOLD_MINUTES + 2) * 60 * 1000);

  const booking = await Booking.create({
    invitationToken: crypto.randomBytes(16).toString("hex"),
    user: user._id,
    tables: allTables.map((t) => t._id),
    partySize: guests,
    customerName: name,
    customerEmail: email,
    customerPhone: phone,
    notes: `Booked via ${r.channel} DM (AI assistant).`,
    occasion: r.occasion || "",
    needDj: Boolean(r.dj),
    needPhotographer: Boolean(r.photographer),
    photographerHours: r.photographer ? Math.max(2, Number(r.photographerHours) || 2) : 0,
    cateringMenu: "",
    totalAmount: q.total,
    originalAmount: q.total,
    finalAmount: q.total,
    complimentaryDrinks: guests * 2,
    bookingDate: parsedDate,
    bookingTime: startTime,
    eventEndTime,
    bookingType: "private_event",
    durationHours: duration,
    status: "pending",
    depositAmount: deposit,
    remainingAmount: remaining,
    remainingPaymentStatus: remaining === 0 ? "paid" : "unpaid",
    remainingPaymentReminderSent: false,
    paymentMethod: "card",
    zelleVerificationStatus: "none",
    utmSource: /face|fb|messenger/i.test(r.channel) ? "facebook" : "instagram",
    utmMedium: "ai_dm",
    utmCampaign: "ai_booking_assistant",
    aiContactId: r.contactId,
    aiHoldExpiresAt: holdUntil,
    quoteHistory: [
      {
        action: "inquiry_created",
        actor: "user",
        actorName: name,
        notes: `Private buyout requested through the ${r.channel} AI assistant`,
        createdAt: new Date()
      }
    ]
  } as any);

  await createSlotLocksForPrivateEvent(booking._id, parsedDate, startTime, duration);

  // ---- Stripe deposit link
  const base = getFrontendBaseUrl();
  const ref = bookingRef(booking._id);
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: {
              name: `Tropica Venue – Security Deposit ($${deposit.toFixed(2)})`,
              description: `Private venue ${prettyDate(date)}, ${to12h(startTime)}–${to12h(endTime(startTime, duration))}, ${guests} guests`
            },
            unit_amount: computeChargeAmount(deposit)
          }
        }
      ],
      metadata: {
        bookingId: String(booking._id),
        userId: String(user._id),
        customerName: name,
        customerPhone: phone,
        partySize: String(guests),
        bookingDate: date,
        bookingTime: startTime,
        occasion: r.occasion || "",
        bookingType: "private_event",
        tableNumbers: "N/A",
        notes: "AI DM booking",
        isBalancePayment: "false",
        source: "ai_dm",
        aiContactId: r.contactId
      },
      payment_intent_data: { description: `Tropica Booking #${ref} – ${name} – DEPOSIT (AI DM)` },
      expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60 + 30,
      success_url: `${base}/booking/paid?session_id={CHECKOUT_SESSION_ID}&bookingId=${booking.id}`,
      cancel_url: `${base}/booking/paid?bookingId=${booking.id}&cancelled=1`
    });
  } catch (err: any) {
    logger.error("[AI] Stripe session failed", { error: err?.message });
    await SlotLock.deleteMany({ eventId: booking._id });
    booking.status = "cancelled";
    await booking.save();
    return { ok: false, error: "Couldn't create the payment link right now." };
  }

  booking.aiStripeSessionId = session.id;
  await booking.save();

  const hold = {
    bookingId: String(booking._id),
    ref,
    paymentUrl: session.url as string,
    expiresAt: holdUntil,
    deposit,
    total: q.total,
    status: "awaiting_payment" as const
  };
  await AiConversation.updateOne({ contactId: r.contactId }, { $set: { hold, contactEmail: email, contactPhone: phone } });

  logger.info("[AI] booking hold created", { ref, date, startTime, duration, guests, contactId: r.contactId });
  return {
    ok: true,
    bookingRef: ref,
    paymentUrl: session.url,
    heldForMinutes: HOLD_MINUTES,
    summary: `${prettyDate(date)}, ${to12h(startTime)}–${to12h(endTime(startTime, duration))} (${duration}h), ${guests} guests`,
    total: q.total,
    deposit,
    balanceDueLater: remaining,
    note: `Slot held for ${HOLD_MINUTES} minutes. NOT confirmed until the $${deposit} deposit is paid through paymentUrl.`
  };
};

/** Marks a paid deposit the same way the Stripe webhook does (idempotent). */
const confirmDeposit = async (booking: any, session: any) => {
  const txnId = session.payment_intent ? String(session.payment_intent) : session.id;
  const alreadyRecorded = booking.paymentBreakdown?.some((p: any) => p.transactionId === txnId);
  if (booking.remainingAmount === 0) {
    booking.paymentStatus = "paid";
    booking.remainingPaymentStatus = "paid";
  } else {
    booking.paymentStatus = "deposit_paid";
  }
  booking.status = "confirmed";
  booking.aiHoldExpiresAt = undefined;
  if (!alreadyRecorded) {
    booking.paymentBreakdown = booking.paymentBreakdown || [];
    booking.paymentBreakdown.push({
      amount: booking.depositAmount || booking.totalAmount,
      paymentMethod: "card",
      paymentType: "deposit",
      status: "verified",
      transactionId: txnId,
      iterationIndex: 1,
      notes: `Deposit of $${(booking.depositAmount || booking.totalAmount).toFixed(2)} paid via Card (AI DM link)`,
      paidAt: new Date()
    });
  }
  await booking.save();
  if (await claimFirstConfirmation(booking._id)) {
    void sendPaymentEmails(booking);
    void sendGHLBookingEvent(booking);
    if (booking.remainingAmount > 0) {
      void sendRemainingBalanceReminderViaEmailJS(booking, `${getFrontendBaseUrl()}/user/venue-bookings`);
    } else {
      void sendFullPaymentConfirmationViaEmailJS(booking);
    }
  }
};

export type HoldStatus = "awaiting_payment" | "confirmed" | "expired" | "cancelled" | "paid_needs_review";

/**
 * Looks at the booking + Stripe session and settles the hold. Safe to call any number of times.
 * Returns the current status and tells the customer in the DM the first time it becomes confirmed.
 */
export const checkAiHoldPayment = async (bookingId: string, opts: { notifyCustomer?: boolean } = {}): Promise<HoldStatus> => {
  const booking: any = await Booking.findById(bookingId);
  if (!booking) return "cancelled";

  let status: HoldStatus;
  if (booking.status === "confirmed") status = "confirmed";
  else {
    const stripe = getStripe();
    const session: any =
      stripe && booking.aiStripeSessionId ? await stripe.checkout.sessions.retrieve(booking.aiStripeSessionId).catch(() => null) : null;
    const paid = session?.payment_status === "paid";

    if (paid && booking.status === "pending" && booking.paymentStatus === "pending_payment") {
      await confirmDeposit(booking, session);
      status = "confirmed";
    } else if (paid && booking.status === "cancelled") {
      // Paid after the slot was released — never auto-confirm, staff must sort it out
      status = "paid_needs_review";
      logger.error("[AI] Deposit paid after hold was released", { bookingId });
    } else if (booking.status === "cancelled") {
      status = session?.status === "expired" || (booking.aiHoldExpiresAt && booking.aiHoldExpiresAt < new Date()) ? "expired" : "cancelled";
    } else if (session?.status === "expired") {
      await cancelAiHold(bookingId, "Payment link expired");
      status = "expired";
    } else {
      status = "awaiting_payment";
    }
  }

  const conv = booking.aiContactId ? await AiConversation.findOne({ contactId: booking.aiContactId }) : null;
  if (conv?.hold?.bookingId === bookingId && conv.hold.status !== status) {
    const firstConfirm = status === "confirmed" && conv.hold.status !== "confirmed";
    conv.hold.status = status;
    conv.markModified("hold");
    if (status === "confirmed") conv.stage = "closed";
    if (status === "paid_needs_review") {
      conv.aiPaused = true;
      conv.pausedReason = "Deposit paid after the hold expired — staff must confirm or refund";
      conv.stage = "human_required";
    }

    if (firstConfirm && opts.notifyCustomer) {
      const msg = `You're booked! 🎉 Payment received — Tropica is reserved for you on ${prettyDate(
        booking.bookingDate.toISOString().slice(0, 10)
      )} at ${to12h(booking.bookingTime)} for ${booking.partySize} guests. Booking #${bookingRef(booking._id)}. A confirmation email is on its way to ${booking.customerEmail}.${
        booking.remainingAmount > 0 ? ` The remaining $${booking.remainingAmount} is due 72 hours before the event.` : ""
      }`;
      conv.messages.push({ role: "assistant", content: msg, at: new Date() });
      await conv.save();
      await deliverReply(conv.contactId, conv.channel, msg);
      return status;
    }
    await conv.save();
  }
  return status;
};

/** Every minute: settle open AI holds (confirms payments even when the Stripe webhook can't reach us). */
let watcherStarted = false;
export const startAiHoldWatcher = () => {
  if (watcherStarted) return;
  watcherStarted = true;
  const tick = async () => {
    try {
      const open = await Booking.find({
        aiStripeSessionId: { $exists: true, $ne: null },
        // pending → check Stripe; confirmed (e.g. by the Stripe webhook) → make sure the customer got the DM
        status: { $in: ["pending", "confirmed"] },
        createdAt: { $gt: new Date(Date.now() - 6 * 3600 * 1000) }
      }).select("_id");
      for (const b of open) await checkAiHoldPayment(String(b._id), { notifyCustomer: true });
    } catch (err: any) {
      logger.warn("[AI] hold watcher error", { error: err?.message });
    }
  };
  setInterval(tick, 60 * 1000).unref();
};

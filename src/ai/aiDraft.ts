import crypto from "crypto";
import logger from "../config/logger";
import AiBookingDraft, { IAiBookingDraft } from "../models/AiBookingDraft";
import AiConversation from "../models/AiConversation";
import Booking from "../models/Booking";
import { getStripe } from "../controllers/payment.controller";
import { isPrivateSlotAvailable } from "../services/booking/private.service";
import { buildDayRange } from "../utils/time.utils";
import { checkVenueAvailability, priceQuote } from "./availability";
import { endTime, isValidYmd, normalizeTime, nyToday, prettyDate, to12h } from "./dates";
import { getPricing, MAX_DURATION, MIN_DURATION, siteLinks } from "./knowledge";

/**
 * Chat booking flow (Instagram / Facebook DM through GHL):
 *
 *   1. check   → the bot sends every detail it collected; we validate, check LIVE availability and price it.
 *   2. draft   → after the customer says YES, we re-check and HOLD the venue window for 30 minutes,
 *                store the draft for 1 hour and return a booking ID + checkout link.
 *   3. website → /book-venue/complete/<bookingId>: phone verification → details → payment → account.
 *                Paying turns the draft into a real Booking (see reserve-private, aiDraftCode).
 */

export const DRAFT_HOLD_MINUTES = 30;
export const DRAFT_TTL_MINUTES = 60;
// 25 seated / 30 standing (standing max comes from settings, capped at 30)
const SEATED_CAPACITY = 25;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

const newCode = () => {
  const bytes = crypto.randomBytes(6);
  return `TRP-${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
};

/** US-first phone normalisation → E.164, or null. */
export const normalizeDraftPhone = (raw?: string): string | null => {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (hasPlus && d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
};

export interface DraftInput {
  date?: string;
  start_time?: string;
  duration_hours?: number | string;
  guests?: number | string;
  seating?: string;
  occasion?: string;
  dj?: boolean | string;
  photographer?: boolean | string;
  photographer_hours?: number | string;
  full_name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  contactId?: string;
  channel?: string;
  /** Partner catering chosen in the chat: "jamaican_jerk_house,cooklyn_eats" + dish names (price set later by the team). */
  catering_menu?: string;
  catering_dishes?: string[];
  /** People per dish + optional portion style */
  catering_items?: { name: string; people: number; portion: string }[];
  catering_notes?: string;
}

const bool = (v: unknown) => v === true || v === "true" || v === "yes" || v === 1 || v === "1";

/** Validates + normalises everything. `missing` lists what the bot still has to ask for. */
const normalize = async (a: DraftInput, requireContact: boolean) => {
  const pricing = await getPricing();
  const missing: string[] = [];
  const problems: string[] = [];

  const date = isValidYmd(a.date) ? a.date : undefined;
  if (!date) missing.push("event date");
  else if (date < nyToday()) problems.push("That date is in the past.");

  const startTime = normalizeTime(a.start_time) || undefined;
  if (!startTime) missing.push("start time");

  const rawHours = Math.round(Number(a.duration_hours) || 5);
  const durationHours = Math.min(MAX_DURATION, Math.max(MIN_DURATION, rawHours));
  if (rawHours > MAX_DURATION) problems.push(`Maximum is ${MAX_DURATION} total hours.`);

  const guests = Math.round(Number(a.guests)) || 0;
  if (!guests) missing.push("guest count");
  if (guests > pricing.maxGuestCapacity) problems.push(`Over capacity (${SEATED_CAPACITY} seated / ${pricing.maxGuestCapacity} standing) — use the Large Events process.`);
  const seating = a.seating === "standing" || a.seating === "seated" ? a.seating : undefined;
  if (guests > SEATED_CAPACITY && guests <= pricing.maxGuestCapacity && seating !== "standing") {
    if (seating === "seated") problems.push(`Seated events fit up to ${SEATED_CAPACITY} guests.`);
    else missing.push(`seated or standing (${SEATED_CAPACITY + 1}-${pricing.maxGuestCapacity} guests must be standing)`);
  }

  const fullName = (a.full_name || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined;
  const phone = normalizeDraftPhone(a.phone) || undefined;
  const emailRaw = (a.email || "").trim().toLowerCase();
  const email = EMAIL_RE.test(emailRaw) ? emailRaw : undefined;
  if (requireContact) {
    if (!fullName || fullName.split(" ").length < 2) missing.push("full name (first and last)");
    if (!phone) missing.push("mobile phone number");
  }
  if (emailRaw && !email) problems.push("That email doesn't look valid.");

  const needDj = bool(a.dj);
  const needPhotographer = bool(a.photographer);
  const photographerHours = needPhotographer ? Math.min(12, Math.max(2, Math.round(Number(a.photographer_hours) || 2))) : 0;

  return {
    pricing,
    missing,
    problems,
    v: {
      date,
      startTime,
      durationHours,
      guests,
      seating,
      occasion: (a.occasion || "").trim().slice(0, 80) || undefined,
      needDj,
      needPhotographer,
      photographerHours,
      fullName,
      phone,
      email,
      notes: (a.notes || "").trim().slice(0, 1000) || undefined,
      cateringMenu: /^[a-z_,]+$/.test(a.catering_menu || "") ? a.catering_menu : undefined,
      selectedDishes: (Array.isArray(a.catering_dishes) ? a.catering_dishes : []).map((d) => String(d).slice(0, 120)).slice(0, 40),
      // Mongo map keys can't contain "." or "$"
      dishPeople: Object.fromEntries(
        (a.catering_items || [])
          .filter((it) => it?.name && Number(it.people) > 0)
          .map((it) => [String(it.name).replace(/[.$]/g, "").slice(0, 120), Math.min(500, Math.round(Number(it.people)))])
      ),
      dishPortions: Object.fromEntries(
        (a.catering_items || [])
          .filter((it) => it?.name && ["individual", "half_tray", "full_tray"].includes(it.portion))
          .map((it) => [String(it.name).replace(/[.$]/g, "").slice(0, 120), it.portion])
      ),
      cateringNotes: (a.catering_notes || "").trim().slice(0, 500) || undefined
    }
  };
};

const quoteFor = (pricing: Awaited<ReturnType<typeof getPricing>>, v: { guests: number; durationHours: number; needDj: boolean; needPhotographer: boolean; photographerHours: number }) =>
  priceQuote(pricing, v.guests, v.durationHours, v.needDj, v.needPhotographer, v.photographerHours || 2);

/**
 * STEP 1 — POST /api/ai/bookings/check
 * Live availability + exact quote for everything the customer chose. Nothing is held.
 */
export const checkDraft = async (a: DraftInput) => {
  const { pricing, missing, problems, v } = await normalize(a, false);
  if (!v.date) return { ok: false, available: false, missing, problems, error: "An event date is required to check availability." };

  const live: any = await checkVenueAvailability({ date: v.date, start_time: v.startTime, duration_hours: v.durationHours, guests: v.guests || undefined });
  if (!live.ok) return { ok: false, available: false, missing, problems, error: live.error };

  const quote = v.guests && v.guests <= pricing.maxGuestCapacity ? quoteFor(pricing, v) : undefined;
  const available = Boolean(v.startTime && live.requestedAvailable && !problems.length);
  return {
    ok: true,
    available,
    readyToConfirm: available && !missing.length,
    missing,
    problems,
    date: v.date,
    dateLabel: prettyDate(v.date),
    startTime: v.startTime ? to12h(v.startTime) : undefined,
    window: v.startTime ? `${to12h(v.startTime)}–${to12h(endTime(v.startTime, v.durationHours))}` : undefined,
    durationHours: v.durationHours,
    extraHours: Math.max(0, v.durationHours - 5),
    guests: v.guests || undefined,
    guestNote: live.guestNote,
    openStartTimes: live.openStartTimes,
    quote: quote
      ? {
          base: quote.base,
          billableGuests: quote.billableGuests,
          extraHours: quote.extraHours,
          extraHoursCost: quote.extraHoursCost,
          dj: quote.dj,
          photographer: quote.photographer,
          total: quote.total,
          deposit: quote.deposit,
          balance: quote.balance,
          customerLine: quote.customerLine,
          text: quote.text
        }
      : undefined,
    summary: live.summary,
    note: "Not held yet. After the customer clearly says YES to the recap, call the draft step to hold it for 30 minutes."
  };
};

const publicLink = (code: string) => `${siteLinks().venue}/complete/${code}`;

/**
 * STEP 2 — POST /api/ai/bookings/draft  (only after the customer confirmed the recap)
 * Re-checks, holds the window for 30 minutes and returns the booking ID + checkout link.
 */
export const createDraft = async (a: DraftInput) => {
  const { pricing, missing, problems, v } = await normalize(a, true);
  if (missing.length || problems.length || !v.date || !v.startTime) {
    return { ok: false, missing, problems, error: [missing.length ? `Missing: ${missing.join(", ")}` : "", ...problems].filter(Boolean).join(" ") };
  }

  // One live hold per chat: release the previous one so the customer doesn't block themselves
  const contactId = (a.contactId || "").trim() || undefined;
  if (contactId) {
    await AiBookingDraft.updateMany({ contactId, status: "held" }, { $set: { status: "cancelled" } });
  }

  if (!(await isPrivateSlotAvailable(v.date, v.startTime, v.durationHours))) {
    const live: any = await checkVenueAvailability({ date: v.date, duration_hours: v.durationHours });
    return {
      ok: false,
      available: false,
      error: `${prettyDate(v.date)} at ${to12h(v.startTime)} for ${v.durationHours}h was just taken.`,
      openStartTimes: live.openStartTimes || []
    };
  }

  const q = quoteFor(pricing, v);
  const now = Date.now();
  let draft: IAiBookingDraft | null = null;
  for (let i = 0; i < 5 && !draft; i++) {
    try {
      draft = await AiBookingDraft.create({
        code: newCode(),
        contactId,
        channel: a.channel,
        status: "held",
        date: v.date,
        startTime: v.startTime,
        durationHours: v.durationHours,
        guests: Math.max(v.guests, 10),
        seating: v.seating,
        occasion: v.occasion,
        needDj: v.needDj,
        needPhotographer: v.needPhotographer,
        photographerHours: v.photographerHours,
        cateringMenu: v.cateringMenu,
        selectedDishes: v.selectedDishes,
        dishPeople: v.dishPeople,
        dishPortions: v.dishPortions,
        cateringNotes: v.cateringNotes,
        fullName: v.fullName,
        phone: v.phone,
        email: v.email,
        notes: v.notes,
        quote: {
          billableGuests: q.billableGuests,
          base: q.base,
          extraHours: q.extraHours,
          extraHoursCost: q.extraHoursCost,
          dj: q.dj,
          photographer: q.photographer,
          total: q.total,
          deposit: q.deposit,
          balance: q.balance
        },
        holdExpiresAt: new Date(now + DRAFT_HOLD_MINUTES * 60 * 1000),
        expiresAt: new Date(now + DRAFT_TTL_MINUTES * 60 * 1000)
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // code clash → try another
    }
  }
  if (!draft) return { ok: false, error: "Couldn't create the booking right now." };

  logger.info("[AI] booking draft held", { code: draft.code, date: v.date, startTime: v.startTime, hours: v.durationHours, guests: v.guests, contactId });
  return {
    ok: true,
    bookingId: draft.code,
    checkoutUrl: publicLink(draft.code),
    heldForMinutes: DRAFT_HOLD_MINUTES,
    holdExpiresAt: draft.holdExpiresAt.toISOString(),
    summary: `${prettyDate(v.date)}, ${to12h(v.startTime)}–${to12h(endTime(v.startTime, v.durationHours))} (${v.durationHours}h), ${v.guests} guests`,
    total: q.total,
    deposit: q.deposit,
    balanceDueLater: q.balance,
    note: `Held for ${DRAFT_HOLD_MINUTES} minutes. NOT booked until they verify their phone and pay the deposit at checkoutUrl. Share bookingId and checkoutUrl exactly.`
  };
};

/** Releases the chat's open hold (customer changed their mind). */
export const cancelDraftsFor = async (contactId: string) =>
  (await AiBookingDraft.updateMany({ contactId, status: "held" }, { $set: { status: "cancelled" } })).modifiedCount;

/** The draft as the checkout page sees it. A draft past its 30-min hold can still be paid if the slot is still free. */
export const getPublicDraft = async (code: string) => {
  const draft = await AiBookingDraft.findOne({ code: code.toUpperCase() }).lean();
  if (!draft) return null;
  const holdActive = draft.status === "held" && new Date(draft.holdExpiresAt).getTime() > Date.now();
  const slotStillFree =
    draft.status === "held" && !holdActive ? await isPrivateSlotAvailable(draft.date, draft.startTime, draft.durationHours, undefined, draft.code) : holdActive;
  return {
    bookingId: draft.code,
    status: draft.status === "held" ? (holdActive ? "held" : slotStillFree ? "hold_expired_still_free" : "expired") : draft.status,
    holdExpiresAt: draft.holdExpiresAt,
    date: draft.date,
    dateLabel: prettyDate(draft.date),
    startTime: draft.startTime,
    durationHours: draft.durationHours,
    guests: draft.guests,
    seating: draft.seating,
    occasion: draft.occasion,
    needDj: draft.needDj,
    needPhotographer: draft.needPhotographer,
    photographerHours: draft.photographerHours,
    cateringMenu: draft.cateringMenu || "",
    selectedDishes: draft.selectedDishes || [],
    dishPeople: draft.dishPeople || {},
    dishPortions: draft.dishPortions || {},
    cateringNotes: draft.cateringNotes || "",
    fullName: draft.fullName,
    phone: draft.phone,
    email: draft.email,
    notes: draft.notes,
    quote: draft.quote
  };
};

/** Website checkout: is this draft usable for this exact booking? Returns its code to exclude its own hold. */
export const draftForCheckout = async (code: unknown, date: string, startTime: string, durationHours: number) => {
  if (typeof code !== "string" || !/^TRP-[A-Z0-9]{6}$/i.test(code)) return null;
  const draft = await AiBookingDraft.findOne({ code: code.toUpperCase(), status: "held" });
  if (!draft) return null;
  const ymd = buildDayRange(date).parsedDate.toISOString().slice(0, 10);
  const sameSlot = draft.date === ymd && draft.startTime === startTime && draft.durationHours === durationHours;
  return sameSlot ? draft : null;
};

export const markDraftCompleted = async (code: string, bookingId: unknown) => {
  await AiBookingDraft.updateOne({ code, status: "held" }, { $set: { status: "completed", bookingId, completedAt: new Date() } });
  // The draft is deleted after 1 hour — keep the link on the chat so "I paid" can still be checked later
  await AiConversation.updateOne({ "draft.code": code }, { $set: { "draft.bookingId": String(bookingId) } });
};

const PAYMENT_LABEL: Record<string, string> = {
  pending_payment: "not paid yet",
  deposit_paid: "deposit paid",
  paid: "paid in full"
};

const ZELLE_LABEL: Record<string, string> = {
  pending_ghl_verification: "Zelle screenshot received — the team is verifying it",
  manual_review: "Zelle payment is being reviewed by the team",
  mismatched: "Zelle payment didn't match — the team will reach out",
  verified: "Zelle payment verified"
};

/** Card paid in Stripe but not yet recorded on the booking (e.g. checkout page closed early)? */
const stripePaidAmount = async (bookingId: string): Promise<number> => {
  const stripe = getStripe();
  if (!stripe) return 0;
  try {
    const found = await stripe.paymentIntents.search({ query: `metadata['bookingId']:'${bookingId}' AND status:'succeeded'`, limit: 5 });
    return found.data.reduce((sum, pi) => sum + (pi.amount_received || 0), 0) / 100;
  } catch {
    return 0;
  }
};

/**
 * "I made the payment" → status of the ONE booking made in this chat. Reads only the booking linked to this
 * conversation's draft — never searches other bookings, so it can't reveal anyone else's details.
 */
export const getChatBookingPayment = async (contactId: string) => {
  const conv = await AiConversation.findOne({ contactId }).select("draft").lean();
  const ref = conv?.draft;
  if (!ref?.code) return { ok: false, noBooking: true, error: "No booking was created in this chat — nothing to check." };

  const draft = await AiBookingDraft.findOne({ code: ref.code }).lean();
  const bookingId = ref.bookingId || (draft?.bookingId ? String(draft.bookingId) : undefined);

  if (!bookingId) {
    const minsLeft = Math.round((new Date(ref.holdExpiresAt).getTime() - Date.now()) / 60000);
    return {
      ok: true,
      bookingId: ref.code,
      stage: "checkout_not_started",
      paid: 0,
      summary:
        minsLeft > 0
          ? `No payment yet — checkout for ${ref.code} hasn't been completed. The date is still held for ${minsLeft} more min.`
          : `No payment found for ${ref.code} — checkout wasn't completed and the 30-minute hold has ended.`,
      checkoutUrl: ref.checkoutUrl
    };
  }

  const b: any = await Booking.findById(bookingId)
    .select(
      "status paymentStatus paymentMethod totalAmount depositAmount remainingAmount remainingPaymentStatus zelleVerificationStatus paymentBreakdown bookingDate bookingTime durationHours partySize needDj needPhotographer photographerHours occasion"
    )
    .lean();
  if (!b) return { ok: false, error: "Booking record not found — offer the team." };

  const fromBreakdown = (b.paymentBreakdown || []).filter((p: any) => p.status === "verified").reduce((s: number, p: any) => s + (p.amount || 0), 0);
  // Card payments made on the website don't always add a breakdown entry — trust the booking's own status then
  const verified =
    fromBreakdown ||
    (b.paymentStatus === "paid" ? b.totalAmount || 0 : b.paymentStatus === "deposit_paid" ? b.depositAmount || 0 : 0);
  const pending = (b.paymentBreakdown || []).filter((p: any) => p.status === "pending").reduce((s: number, p: any) => s + (p.amount || 0), 0);
  const stripeOnly = b.paymentStatus === "pending_payment" && b.paymentMethod !== "zelle" ? await stripePaidAmount(bookingId) : 0;
  const date = new Date(b.bookingDate).toISOString().slice(0, 10);
  const balance =
    b.paymentStatus === "paid" || b.remainingPaymentStatus === "paid"
      ? 0
      : typeof b.remainingAmount === "number" && verified > 0
        ? Math.max(0, b.remainingAmount)
        : Math.max(0, (b.totalAmount || 0) - verified);

  let summary: string;
  if (b.status === "cancelled") summary = "This booking was cancelled.";
  else if (b.paymentStatus === "paid") summary = `Paid in full ($${verified || b.totalAmount}). Booking confirmed.`;
  else if (b.paymentStatus === "deposit_paid") summary = `Deposit received: $${verified || b.depositAmount} paid. Booking confirmed. Remaining balance $${balance} is due 72 hours before the event.`;
  else if (stripeOnly > 0) summary = `Card payment of $${stripeOnly} received by our payment processor — the booking is being finalized. If it doesn't update shortly, the team will confirm.`;
  else if (b.paymentMethod === "zelle" && ZELLE_LABEL[b.zelleVerificationStatus]) summary = `${ZELLE_LABEL[b.zelleVerificationStatus]}${pending ? ` ($${pending})` : ""}. Not confirmed until verified.`;
  else summary = "No payment has been received for this booking yet.";

  return {
    ok: true,
    bookingId: ref.code,
    stage: b.status === "cancelled" ? "cancelled" : PAYMENT_LABEL[b.paymentStatus] || b.paymentStatus,
    confirmed: b.status !== "cancelled" && ["deposit_paid", "paid"].includes(b.paymentStatus),
    method: b.paymentMethod,
    paid: verified,
    pendingVerification: pending || undefined,
    total: b.totalAmount,
    deposit: b.depositAmount,
    balance,
    balanceDue: balance > 0 ? "72 hours before the event" : undefined,
    event: `${prettyDate(date)}, ${to12h(b.bookingTime)}–${to12h(endTime(b.bookingTime, b.durationHours || 5))} (${b.durationHours || 5}h), ${b.partySize} guests${b.occasion ? `, ${b.occasion}` : ""}`,
    included: [b.needDj ? "DJ" : "", b.needPhotographer ? `photographer ${b.photographerHours || 2}h` : ""].filter(Boolean).join(", ") || "no add-ons",
    notIncluded: [b.needDj ? "" : "DJ", b.needPhotographer ? "" : "photography"].filter(Boolean),
    summary,
    note: "Only share THIS booking's details. Never confirm a payment the summary doesn't state."
  };
};

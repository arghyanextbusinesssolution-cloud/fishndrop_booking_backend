import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import PartnerVenue, { DEFAULT_VENUE_THEME, resolveWeeklyHours } from "../../models/PartnerVenue";
import { parseWeeklyHours } from "./admin.controller";
import MarketplaceBooking, { IMarketplaceBooking } from "../../models/MarketplaceBooking";
import VenueBlock from "../../models/VenueBlock";
import logger from "../../config/logger";
import { toPublicVenue } from "./public.controller";
import { isRangeFree, isValidSessionDate, nyTodayAndNow } from "../../services/marketplace/availability.service";
import { notifyRequestConfirmed, notifyRequestDeclined } from "../../services/marketplace/notifications.service";
import { sanitizeString, timeToMinutes } from "../../utils/time.utils";
import { getStripe } from "../../utils/stripe.utils";
import { getFrontendBaseUrl } from "../../utils/siteUrl";
import { describeAccount, simulatorAvailable } from "../stripeConnect.controller";
import { buildReport } from "../../services/marketplace/report.service";
import { autoSettleVenue } from "../../services/marketplace/settlement.service";

/**
 * Partner portal API (role "venue_owner"). Every handler is scoped to req.user.partnerVenue —
 * an owner can never read or change another venue's data.
 */

const PAYMENT_LINK_HOURS = Number(process.env.MARKETPLACE_PAYMENT_LINK_HOURS || 48);

const myVenueId = (req: Request) => req.user!.partnerVenue!;
const errMsg = (res: Response, code: number, message: string) => res.status(code).json({ success: false, message });

/** Owner's view of a booking: contact details only once the customer has paid. */
const toOwnerBooking = (b: IMarketplaceBooking) => {
  const paid = ["deposit_paid", "paid", "completed"].includes(b.status);
  return {
    _id: b._id,
    bookingNumber: b.bookingNumber,
    status: b.status,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    durationHours: b.durationHours,
    guests: b.guests,
    packageName: b.packageName,
    occasion: b.occasion,
    notes: b.notes,
    customerName: b.customerName,
    customerEmail: paid ? b.customerEmail : undefined,
    customerPhone: paid ? b.customerPhone : undefined,
    regularPrice: b.regularPrice,
    venuePayout: b.venuePayout,
    amountPaid: b.amountPaid,
    remainingAmount: b.remainingAmount,
    declineReason: b.declineReason,
    cancelReason: b.cancelReason,
    paymentLinkExpiresAt: b.paymentLinkExpiresAt,
    respondedAt: b.respondedAt,
    settlement: b.settlement,
    payments: (b.payments || []).map((p) => ({ amount: p.amount, paymentType: p.paymentType, status: p.status, paidAt: p.paidAt })),
    createdAt: b.createdAt
  };
};

/* ─── Venue overview ─────────────────────────────────────────────────── */

/** GET /api/marketplace/partner/venue — the owner's own venue, as customers see it, plus status. */
export const getMyVenue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    const [openRequests, upcoming] = await Promise.all([
      MarketplaceBooking.countDocuments({ venue: venue._id, status: "requested" }),
      MarketplaceBooking.countDocuments({ venue: venue._id, status: { $in: ["deposit_paid", "paid"] } })
    ]);
    res.status(200).json({
      success: true,
      venue: {
        ...toPublicVenue(venue),
        status: venue.status,
        basePrice: venue.basePrice,
        partnerDiscountPct: venue.partnerDiscountPct,
        chargesEnabled: venue.chargesEnabled,
        payoutsEnabled: venue.payoutsEnabled,
        operatingDays: venue.operatingDays,
        weeklyHours: resolveWeeklyHours(venue),
        slotStepMins: venue.slotStepMins
      },
      stats: { openRequests, upcoming }
    });
  } catch (error) {
    next(error);
  }
};

/* ─── Booking requests: accept / decline ─────────────────────────────── */

/** GET /api/marketplace/partner/requests?status=requested|answered|all */
export const listMyRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = String(req.query.status || "requested");
    const filter: Record<string, unknown> = { venue: myVenueId(req) };
    if (status === "requested") filter.status = "requested";
    else if (status === "answered") filter.status = { $in: ["availability_confirmed", "declined", "expired"] };
    else filter.status = { $in: ["requested", "availability_confirmed", "declined", "expired"] };
    const bookings = await MarketplaceBooking.find(filter).sort(status === "requested" ? { date: 1, startMin: 1 } : { updatedAt: -1 }).limit(200);
    const waiting = await MarketplaceBooking.countDocuments({ venue: myVenueId(req), status: "requested" });
    res.status(200).json({ success: true, waiting, requests: bookings.map(toOwnerBooking) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/marketplace/partner/requests/:id/confirm — date is available → customer gets a payment link. */
export const confirmMyRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = await MarketplaceBooking.findOne({ _id: req.params.id, venue: myVenueId(req) });
    if (!booking) return void errMsg(res, 404, "Request not found");
    if (booking.status !== "requested") return void errMsg(res, 409, `This request was already ${booking.status.replace(/_/g, " ")}.`);
    if (!(await isRangeFree(booking.venue, booking.date, booking.startMin, booking.endMin))) {
      return void errMsg(res, 409, "This time is now blocked on your calendar. Unblock it first, or decline the request.");
    }
    const venue = await PartnerVenue.findById(booking.venue);
    if (!venue) return void errMsg(res, 404, "Venue not found");

    // Atomic so a double-click (or staff acting at the same time) can't confirm twice.
    const updated = await MarketplaceBooking.findOneAndUpdate(
      { _id: booking._id, status: "requested" },
      {
        $set: {
          status: "availability_confirmed",
          respondedBy: req.user!._id,
          respondedByRole: "venue_owner",
          respondedAt: new Date(),
          paymentLinkSentAt: new Date(),
          paymentLinkExpiresAt: new Date(Date.now() + PAYMENT_LINK_HOURS * 3600 * 1000)
        }
      },
      { new: true }
    );
    if (!updated) return void errMsg(res, 409, "This request was just answered.");

    logger.info(`[MARKETPLACE] Owner ${req.user!.email} confirmed ${updated.bookingNumber} (${venue.name})`);
    notifyRequestConfirmed(updated, venue);
    res.status(200).json({ success: true, message: "Confirmed — the customer has been sent a payment link.", request: toOwnerBooking(updated) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/marketplace/partner/requests/:id/decline  { reason } */
export const declineMyRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reason = sanitizeString(req.body?.reason).slice(0, 500);
    if (!reason) return void errMsg(res, 400, "Please tell the customer why (e.g. already booked that evening).");
    const updated = await MarketplaceBooking.findOneAndUpdate(
      { _id: req.params.id, venue: myVenueId(req), status: "requested" },
      {
        $set: {
          status: "declined",
          declineReason: reason,
          respondedBy: req.user!._id,
          respondedByRole: "venue_owner",
          respondedAt: new Date()
        }
      },
      { new: true }
    );
    if (!updated) return void errMsg(res, 409, "This request is no longer waiting for a response.");
    const venue = await PartnerVenue.findById(updated.venue);
    if (venue) notifyRequestDeclined(updated, venue);
    logger.info(`[MARKETPLACE] Owner ${req.user!.email} declined ${updated.bookingNumber}: ${reason}`);
    res.status(200).json({ success: true, message: "Declined — the customer has been told.", request: toOwnerBooking(updated) });
  } catch (error) {
    next(error);
  }
};

/* ─── Confirmed bookings + payouts ───────────────────────────────────── */

/** GET /api/marketplace/partner/bookings?scope=upcoming|past */
export const listMyBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { today } = nyTodayAndNow();
    const past = req.query.scope === "past";
    const bookings = await MarketplaceBooking.find({
      venue: myVenueId(req),
      status: { $in: ["deposit_paid", "paid", "completed", "cancelled"] },
      date: past ? { $lt: today } : { $gte: today }
    })
      .sort(past ? { date: -1 } : { date: 1, startMin: 1 })
      .limit(300);
    res.status(200).json({ success: true, bookings: bookings.map(toOwnerBooking) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/marketplace/partner/payouts — what Tropica owes / has paid this venue. */
export const listMyPayouts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookings = await MarketplaceBooking.find({
      venue: myVenueId(req),
      status: { $in: ["deposit_paid", "paid", "completed", "cancelled"] },
      amountPaid: { $gt: 0 }
    }).sort({ date: -1 });
    const rows = bookings.map(toOwnerBooking);
    const totals = rows.reduce(
      (t, b) => {
        t.bookedPayout += b.status === "cancelled" ? 0 : b.venuePayout;
        if (b.settlement?.status === "transferred" || b.settlement?.status === "paid_manually") t.paidOut += b.venuePayout;
        return t;
      },
      { bookedPayout: 0, paidOut: 0 }
    );
    res.status(200).json({ success: true, totals: { ...totals, pending: Math.max(0, totals.bookedPayout - totals.paidOut) }, bookings: rows });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/marketplace/partner/report — the owner's earnings dashboard.
 * Only the venue's own share is exposed (no customer price / Tropica commission).
 */
export const getMyReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const r = await buildReport({ venue: myVenueId(req) });
    const t = r.totals;
    res.status(200).json({
      success: true,
      totals: {
        bookings: t.bookings,
        guests: t.guests,
        earned: t.payout,
        received: t.payoutSettled,
        pending: t.payoutPending,
        upcomingBookings: t.upcomingBookings,
        upcomingEarnings: t.upcomingPayout,
        averagePerBooking: t.bookings ? Math.round((t.payout / t.bookings) * 100) / 100 : 0
      },
      thisMonth: { month: r.thisMonth.month, earned: r.thisMonth.payout, bookings: r.thisMonth.bookings },
      lastMonth: { earned: r.lastMonth.payout, bookings: r.lastMonth.bookings },
      monthly: r.monthly.map((m) => ({ month: m.month, bookings: m.bookings, earned: m.payout, upcoming: m.upcoming }))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/marketplace/partner/calendar?month=YYYY-MM
 * Everything on the venue's calendar for one month: bookings (incl. open requests) and manual blocks.
 */
export const getMyCalendar = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : nyTodayAndNow().today.slice(0, 7);
    const range = { $gte: `${month}-01`, $lte: `${month}-31` };
    const [bookings, blocks] = await Promise.all([
      MarketplaceBooking.find({
        venue: myVenueId(req),
        date: range,
        status: { $in: ["requested", "availability_confirmed", "deposit_paid", "paid", "completed"] }
      }).sort({ date: 1, startMin: 1 }),
      VenueBlock.find({ venue: myVenueId(req), date: range, reason: "manual" }).sort({ date: 1, startMin: 1 }).lean()
    ]);
    res.status(200).json({
      success: true,
      month,
      bookings: bookings.map(toOwnerBooking),
      blocks: blocks.map((b: any) => ({ _id: b._id, date: b.date, startMin: b.startMin, endMin: b.endMin, note: b.note }))
    });
  } catch (error) {
    next(error);
  }
};

/* ─── Availability blocks ────────────────────────────────────────────── */

/** GET /api/marketplace/partner/blocks?from=YYYY-MM-DD */
export const listMyBlocks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const from = isValidSessionDate(String(req.query.from || "")) ? String(req.query.from) : nyTodayAndNow().today;
    const blocks = await VenueBlock.find({ venue: myVenueId(req), date: { $gte: from } })
      .sort({ date: 1, startMin: 1 })
      .populate("booking", "bookingNumber customerName guests")
      .limit(500);
    res.status(200).json({ success: true, blocks });
  } catch (error) {
    next(error);
  }
};

/** POST /api/marketplace/partner/blocks  { date, allDay?, startTime?, endTime?, note? } */
export const createMyBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    const date = String(req.body?.date || "");
    if (!isValidSessionDate(date) || date < nyTodayAndNow().today) return void errMsg(res, 400, "Pick today or a future date");

    let startMin: number;
    let endMin: number;
    if (req.body?.allDay !== false) {
      // Whole day, including a late-night close after midnight
      startMin = 0;
      endMin = 48 * 60;
    } else {
      const s = String(req.body?.startTime || "");
      const e = String(req.body?.endTime || "");
      if (!/^\d{2}:\d{2}$/.test(s) || !/^\d{2}:\d{2}$/.test(e)) return void errMsg(res, 400, "Enter a start and end time");
      startMin = timeToMinutes(s);
      endMin = timeToMinutes(e);
      if (endMin <= startMin) endMin += 1440; // ends after midnight
    }
    const block = await VenueBlock.create({
      venue: venue._id,
      date,
      startMin,
      endMin,
      reason: "manual",
      note: sanitizeString(req.body?.note).slice(0, 300) || undefined,
      createdBy: req.user!._id
    });
    res.status(201).json({ success: true, block });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/marketplace/partner/blocks/:id — only manual blocks; paid bookings can't be unblocked here. */
export const deleteMyBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await VenueBlock.deleteOne({ _id: req.params.id, venue: myVenueId(req), reason: "manual" });
    if (!result.deletedCount) return void errMsg(res, 404, "Block not found (blocks from paid bookings can't be removed)");
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

/* ─── Weekly opening hours ───────────────────────────────────────────── */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** PATCH /api/marketplace/partner/venue/hours  { weeklyHours: [{day, open, openTime, closeTime} x7] } */
export const updateMyHours = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    const hours = parseWeeklyHours(req.body?.weeklyHours);
    if (!hours) return void errMsg(res, 400, "Send opening hours for all 7 days");
    if (!hours.some((d) => d.open)) return void errMsg(res, 400, "Your venue needs at least one open day");
    const tooShort = hours.find((d) => {
      if (!d.open) return false;
      let mins = timeToMinutes(d.closeTime) - timeToMinutes(d.openTime);
      if (mins <= 0) mins += 1440;
      return mins < (venue.minHours || 1) * 60;
    });
    if (tooShort) {
      return void errMsg(res, 400, DAY_NAMES[tooShort.day] + " is open for less than your " + venue.minHours + "-hour minimum booking");
    }
    venue.set("weeklyHours", hours);
    await venue.save();
    logger.info("[MARKETPLACE] Owner " + req.user!.email + " updated opening hours for " + venue.name);
    res.status(200).json({ success: true, weeklyHours: resolveWeeklyHours(venue) });
  } catch (error) {
    next(error);
  }
};

/* ─── Brand & theme (the only listing fields owners edit) ───────────── */

const HEX = /^#[0-9a-fA-F]{6}$/;
const okUrl = (v: unknown) => {
  const s = sanitizeString(v);
  return s && (/^https:\/\//.test(s) || s.startsWith("/")) ? s : "";
};

/** PATCH /api/marketplace/partner/venue/brand  { theme?, logoUrl?, coverUrl?, flyerUrl?, photos? } */
export const updateMyBrand = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    const b = req.body || {};
    if (b.theme && typeof b.theme === "object") {
      const theme: Record<string, string> = { ...DEFAULT_VENUE_THEME, ...(venue.theme as any)?.toObject?.() };
      for (const k of Object.keys(DEFAULT_VENUE_THEME)) if (HEX.test(b.theme[k])) theme[k] = b.theme[k].toUpperCase();
      venue.set("theme", theme);
    }
    for (const k of ["logoUrl", "coverUrl", "flyerUrl"] as const) {
      if (k in b) venue.set(k, okUrl(b[k]) || undefined);
    }
    if (Array.isArray(b.photos)) venue.photos = b.photos.map(okUrl).filter(Boolean).slice(0, 20);
    await venue.save();
    res.status(200).json({ success: true, venue: toPublicVenue(venue) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/marketplace/partner/media  { imageBase64, kind } */
export const uploadMyMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { imageBase64 } = req.body || {};
    if (typeof imageBase64 !== "string" || !imageBase64.startsWith("data:image/")) return void errMsg(res, 400, "Please upload an image file");
    const kind = ["logo", "cover", "flyer", "photo"].includes(req.body.kind) ? req.body.kind : "photo";
    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: `tropica_partner_venues/${kind}`,
      resource_type: "image",
      transformation: [{ width: kind === "logo" ? 400 : 1800, crop: "limit" }, { quality: "auto:good" }, { fetch_format: "auto" }]
    });
    res.status(200).json({ success: true, url: result.secure_url });
  } catch (error) {
    next(error);
  }
};

/* ─── Stripe Connect (per venue, same flow promoters use) ───────────── */

const portalUrl = (q: string) => `${getFrontendBaseUrl()}/partner-portal/payouts?connect=${q}`;

/** POST /api/marketplace/partner/connect/create-account */
export const createVenueConnectAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    const stripe = getStripe();
    if (!stripe) {
      if (!simulatorAvailable()) return void errMsg(res, 503, "Stripe is not configured on the server.");
      venue.stripeConnectAccountId = venue.stripeConnectAccountId || `acct_test_${String(venue._id).slice(-12)}`;
      await venue.save();
      res.status(200).json({ success: true, accountId: venue.stripeConnectAccountId, isSimulated: true });
      return;
    }
    if (venue.stripeConnectAccountId && !venue.stripeConnectAccountId.startsWith("acct_test_")) {
      try {
        const existing = await stripe.accounts.retrieve(venue.stripeConnectAccountId);
        res.status(200).json({ success: true, accountId: existing.id });
        return;
      } catch (err: any) {
        logger.warn(`Venue Stripe account ${venue.stripeConnectAccountId} invalid, recreating: ${err.message}`);
      }
    }
    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email: venue.ownerEmail || req.user!.email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: "company",
      business_profile: { name: venue.name, product_description: "Private event venue bookings through Tropica NYC" },
      metadata: { partnerVenueId: String(venue._id) }
    });
    venue.stripeConnectAccountId = account.id;
    venue.chargesEnabled = false;
    venue.payoutsEnabled = account.payouts_enabled;
    venue.stripeConnectOnboarded = account.details_submitted;
    await venue.save();
    logger.info(`[MARKETPLACE] Created Stripe Express account ${account.id} for venue ${venue.name}`);
    res.status(201).json({ success: true, accountId: account.id });
  } catch (error: any) {
    next(new Error(`Failed to create Stripe account: ${error.message}`));
  }
};

/** POST /api/marketplace/partner/connect/onboarding-link */
export const getVenueOnboardingLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    const stripe = getStripe();
    if (!stripe || venue.stripeConnectAccountId?.startsWith("acct_test_")) {
      res.status(200).json({ success: true, url: portalUrl("simulated_success"), isSimulated: true });
      return;
    }
    if (!venue.stripeConnectAccountId) return void errMsg(res, 400, "Start Stripe setup first.");
    const link = await stripe.accountLinks.create({
      account: venue.stripeConnectAccountId,
      refresh_url: portalUrl("refresh"),
      return_url: portalUrl("success"),
      type: "account_onboarding"
    });
    res.status(200).json({ success: true, url: link.url });
  } catch (error: any) {
    next(new Error(`Failed to create onboarding link: ${error.message}`));
  }
};

/** GET /api/marketplace/partner/connect/status */
export const getVenueConnectStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    if (!venue.stripeConnectAccountId) {
      res.status(200).json({ success: true, state: "not_connected", connected: false, requirements: [], simulatorAvailable: simulatorAvailable() });
      return;
    }
    const stripe = getStripe();
    if (!stripe || venue.stripeConnectAccountId.startsWith("acct_test_")) {
      res.status(200).json({
        success: true,
        state: venue.chargesEnabled ? "connected" : "incomplete",
        connected: venue.chargesEnabled,
        payoutsEnabled: venue.payoutsEnabled,
        requirements: [],
        simulatorAvailable: simulatorAvailable(),
        isSimulated: true
      });
      return;
    }
    const account = await stripe.accounts.retrieve(venue.stripeConnectAccountId);
    const info = describeAccount(account);
    venue.chargesEnabled = info.connected;
    venue.payoutsEnabled = Boolean(account.payouts_enabled);
    venue.stripeConnectOnboarded = Boolean(account.details_submitted);
    await venue.save();
    // Money Tropica collected before the venue connected goes out automatically now.
    const settled = info.connected ? await autoSettleVenue(venue._id).catch(() => ({ count: 0, amount: 0 })) : { count: 0, amount: 0 };
    res.status(200).json({ success: true, accountId: account.id, simulatorAvailable: false, ...info, settled });
  } catch (error: any) {
    next(new Error(`Failed to read Stripe status: ${error.message}`));
  }
};

/** POST /api/marketplace/partner/connect/dashboard-link */
export const getVenueDashboardLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue?.stripeConnectAccountId) return void errMsg(res, 400, "Connect Stripe first.");
    const stripe = getStripe();
    if (!stripe || venue.stripeConnectAccountId.startsWith("acct_test_")) {
      res.status(200).json({ success: true, url: "https://dashboard.stripe.com/test", isSimulated: true });
      return;
    }
    const link = await stripe.accounts.createLoginLink(venue.stripeConnectAccountId);
    res.status(200).json({ success: true, url: link.url });
  } catch (error: any) {
    next(new Error(`Failed to open Stripe dashboard: ${error.message}`));
  }
};

/** POST /api/marketplace/partner/connect/simulate-onboarding (local dev without a Stripe key) */
/**
 * POST /api/marketplace/partner/connect/disconnect
 * Unlinks the venue's Stripe account. New payments then go to Tropica, which pays the venue manually.
 * The Stripe account itself is not deleted (past payouts and its dashboard stay intact).
 */
export const disconnectVenueStripe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    if (!venue.stripeConnectAccountId) return void errMsg(res, 400, "Stripe isn't connected.");
    const previous = venue.stripeConnectAccountId;
    venue.stripeConnectAccountId = undefined;
    venue.chargesEnabled = false;
    venue.payoutsEnabled = false;
    venue.stripeConnectOnboarded = false;
    await venue.save();
    logger.info(`[MARKETPLACE] Venue ${venue.name} disconnected Stripe account ${previous} (by ${req.user!.email})`);
    res.status(200).json({ success: true, message: "Stripe disconnected. Tropica will collect new payments and pay you manually." });
  } catch (error) {
    next(error);
  }
};

export const simulateVenueOnboarding = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!simulatorAvailable()) return void errMsg(res, 400, "Real Stripe is configured — please complete Stripe onboarding.");
    const venue = await PartnerVenue.findById(myVenueId(req));
    if (!venue) return void errMsg(res, 404, "Venue not found");
    venue.stripeConnectAccountId = venue.stripeConnectAccountId || `acct_test_${String(venue._id).slice(-12)}`;
    venue.chargesEnabled = true;
    venue.payoutsEnabled = true;
    venue.stripeConnectOnboarded = true;
    await venue.save();
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

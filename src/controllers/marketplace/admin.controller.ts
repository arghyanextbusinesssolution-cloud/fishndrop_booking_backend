import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import PartnerVenue, { ADMIN_ONLY_FIELDS, DEFAULT_VENUE_THEME, IPartnerVenue } from "../../models/PartnerVenue";
import MarketplaceBooking from "../../models/MarketplaceBooking";
import User from "../../models/User";
import logger from "../../config/logger";
import { computeBreakdown, regularPriceFor } from "../../services/marketplace/pricing.service";
import { sendVenueOwnerCredentialsEmail } from "../../services/marketplace/notifications.service";
import { sanitizeString } from "../../utils/time.utils";
import { asObjectId, buildReport, revenueByVenue } from "../../services/marketplace/report.service";
import { settleBooking } from "../../services/marketplace/settlement.service";
import { PaymentError } from "../../services/marketplace/payment.service";

/**
 * Staff (Sarah) creates venue owners + their venue profile; admin/owner sets commission
 * and publishes. Mounted at /api/admin/marketplace behind staffOrAdminOnly.
 */

const isAdminRole = (role?: string) => role === "admin" || role === "owner";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "venue";

const uniqueSlug = async (name: string, ignoreId?: string) => {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await PartnerVenue.findOne({ slug: candidate, ...(ignoreId ? { _id: { $ne: ignoreId } } : {}) }, "_id");
    if (!clash) return candidate;
  }
  return `${base}-${crypto.randomBytes(2).toString("hex")}`;
};

const tempPassword = () => `Venue@${crypto.randomBytes(5).toString("base64url")}7`;

const HEX = /^#[0-9a-fA-F]{6}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const strList = (v: unknown, max = 30) =>
  (Array.isArray(v) ? v : String(v || "").split("\n"))
    .map((x) => sanitizeString(x))
    .filter(Boolean)
    .slice(0, max);
const url = (v: unknown) => {
  const s = sanitizeString(v);
  return s && (/^https:\/\//.test(s) || s.startsWith("/")) ? s : undefined;
};

/** Validate a 7-day schedule from the client; null when malformed. */
export const parseWeeklyHours = (input: unknown) => {
  if (!Array.isArray(input)) return null;
  const byDay = new Map<number, { day: number; open: boolean; openTime: string; closeTime: string }>();
  for (const d of input as any[]) {
    const day = Number(d?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!HHMM.test(d?.openTime) || !HHMM.test(d?.closeTime)) continue;
    byDay.set(day, { day, open: Boolean(d.open), openTime: d.openTime, closeTime: d.closeTime });
  }
  return byDay.size === 7 ? [...byDay.values()].sort((a, b) => a.day - b.day) : null;
};

/** Whitelist + normalise the venue fields staff may set. Commission fields only for admins. */
const pickVenueFields = (body: Record<string, any>, allowCommission: boolean): Partial<IPartnerVenue> => {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  if ("name" in body) set("name", sanitizeString(body.name).slice(0, 120));
  if ("tagline" in body) set("tagline", sanitizeString(body.tagline).slice(0, 160));
  if ("description" in body) set("description", String(body.description || "").trim().slice(0, 5000));
  if ("address" in body) set("address", sanitizeString(body.address));
  if ("neighborhood" in body) set("neighborhood", sanitizeString(body.neighborhood));
  if ("city" in body) set("city", sanitizeString(body.city) || "New York");
  // null clears the map pin (address was retyped by hand)
  const coord = (v: unknown) => (v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  if ("lat" in body) set("lat", coord(body.lat));
  if ("lng" in body) set("lng", coord(body.lng));
  if ("placeId" in body) set("placeId", sanitizeString(body.placeId) || null);
  if ("venueType" in body) set("venueType", sanitizeString(body.venueType) || "event_space");
  if ("amenities" in body) set("amenities", strList(body.amenities));
  if ("rules" in body) set("rules", strList(body.rules));
  if ("cancellationPolicy" in body) set("cancellationPolicy", String(body.cancellationPolicy || "").trim().slice(0, 2000));
  if ("minGuests" in body) set("minGuests", Math.round(num(body.minGuests, 1, 5000, 1)));
  if ("maxGuests" in body) set("maxGuests", Math.round(num(body.maxGuests, 1, 5000, 50)));
  if ("pricingMode" in body) set("pricingMode", body.pricingMode === "flat" ? "flat" : "hourly");
  if ("basePrice" in body) set("basePrice", num(body.basePrice, 0, 1_000_000, 0));
  if ("minHours" in body) set("minHours", num(body.minHours, 1, 24, 2));
  if ("packages" in body && Array.isArray(body.packages)) {
    set(
      "packages",
      body.packages
        .map((p: any) => ({
          ...(p._id ? { _id: p._id } : {}),
          name: sanitizeString(p.name).slice(0, 80),
          price: num(p.price, 0, 1_000_000, 0),
          hours: num(p.hours, 1, 24, 1),
          description: sanitizeString(p.description).slice(0, 300)
        }))
        .filter((p: any) => p.name && p.price > 0)
        .slice(0, 10)
    );
  }
  if ("openTime" in body && HHMM.test(body.openTime)) set("openTime", body.openTime);
  if ("closeTime" in body && HHMM.test(body.closeTime)) set("closeTime", body.closeTime);
  if ("weeklyHours" in body) {
    const hours = parseWeeklyHours(body.weeklyHours);
    if (hours) set("weeklyHours", hours);
  }
  if ("slotStepMins" in body) set("slotStepMins", Number(body.slotStepMins) === 30 ? 30 : 60);
  if ("operatingDays" in body && Array.isArray(body.operatingDays)) {
    set("operatingDays", [...new Set(body.operatingDays.map(Number).filter((d: number) => d >= 0 && d <= 6))]);
  }
  if ("theme" in body && body.theme && typeof body.theme === "object") {
    const theme: Record<string, string> = { ...DEFAULT_VENUE_THEME };
    for (const k of Object.keys(DEFAULT_VENUE_THEME)) if (HEX.test(body.theme[k])) theme[k] = body.theme[k];
    set("theme", theme);
  }
  if ("logoUrl" in body) set("logoUrl", url(body.logoUrl));
  if ("coverUrl" in body) set("coverUrl", url(body.coverUrl));
  if ("flyerUrl" in body) set("flyerUrl", url(body.flyerUrl));
  if ("photos" in body) set("photos", (Array.isArray(body.photos) ? body.photos : []).map(url).filter(Boolean).slice(0, 20));
  if ("ownerName" in body) set("ownerName", sanitizeString(body.ownerName));
  if ("ownerPhone" in body) set("ownerPhone", sanitizeString(body.ownerPhone));
  if ("internalNotes" in body) set("internalNotes", String(body.internalNotes || "").slice(0, 5000));
  if ("agreementSignedAt" in body) set("agreementSignedAt", body.agreementSignedAt ? new Date(body.agreementSignedAt) : undefined);

  if (allowCommission) {
    if ("partnerDiscountPct" in body) set("partnerDiscountPct", num(body.partnerDiscountPct, 0, 100, 0));
    if ("customerDiscountPct" in body) set("customerDiscountPct", num(body.customerDiscountPct, 0, 100, 0));
    if ("depositPct" in body) set("depositPct", num(body.depositPct, 1, 100, 100));
    if ("status" in body && ["draft", "published", "paused"].includes(body.status)) set("status", body.status);
  }
  return out as Partial<IPartnerVenue>;
};

/** Staff/admin list row: venue + owner account + commission preview + request counts. */
const toAdminRow = (v: any, counts: Record<string, number>) => {
  const sample = regularPriceFor(v, v.minHours || 1, v.packages?.[0]?._id).regularPrice;
  return {
    ...v,
    owner: v.ownerUser
      ? { _id: v.ownerUser._id, name: v.ownerUser.name, email: v.ownerUser.email, lastLoginAt: v.ownerUser.lastLoginAt }
      : null,
    ownerUser: undefined,
    commissionPreview: { ...computeBreakdown(sample, v), basis: v.packages?.[0]?.name || `${v.minHours}h minimum` },
    openRequests: counts[String(v._id)] || 0,
    // A venue needs commission terms before it can go live.
    commissionSet: v.partnerDiscountPct > 0 || v.customerDiscountPct > 0
  };
};

/** GET /api/admin/marketplace/venues */
export const listPartnerVenues = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venues = await PartnerVenue.find().sort({ createdAt: -1 }).populate("ownerUser", "name email lastLoginAt").lean();
    const open = await MarketplaceBooking.aggregate([
      { $match: { status: "requested" } },
      { $group: { _id: "$venue", n: { $sum: 1 } } }
    ]);
    const counts = Object.fromEntries(open.map((o) => [String(o._id), o.n]));
    res.status(200).json({ success: true, venues: venues.map((v) => toAdminRow(v, counts)) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/marketplace/venues/:id */
export const getPartnerVenue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(req.params.id).populate("ownerUser", "name email lastLoginAt").lean();
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }
    res.status(200).json({ success: true, venue: toAdminRow(venue, {}) });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/marketplace/venues
 * One call from the "Add venue owner" wizard: creates the owner login + the venue profile (draft).
 * body: { owner: { name, email, phone?, password? }, venue: {...profile fields} }
 */
export const createVenueWithOwner = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  let createdUserId: unknown = null;
  try {
    const owner = req.body.owner || {};
    const ownerName = sanitizeString(owner.name);
    const ownerEmail = sanitizeString(owner.email).toLowerCase();
    const ownerPhone = sanitizeString(owner.phone);
    const password = sanitizeString(owner.password) || tempPassword();

    if (!ownerName || !/^\S+@\S+\.\S+$/.test(ownerEmail)) {
      res.status(400).json({ success: false, message: "Owner name and a valid email are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
      return;
    }

    const venueInput = pickVenueFields(req.body.venue || {}, isAdminRole(req.user?.role));
    if (!venueInput.name) {
      res.status(400).json({ success: false, message: "Venue name is required" });
      return;
    }
    if ((venueInput.minGuests || 1) > (venueInput.maxGuests || 50)) {
      res.status(400).json({ success: false, message: "Minimum guests can't be more than maximum guests" });
      return;
    }

    const existing = await User.findOne({ $or: [{ email: ownerEmail }, ...(ownerPhone ? [{ phone: ownerPhone }] : [])] });
    if (existing) {
      res.status(409).json({ success: false, message: "An account with this email or phone already exists" });
      return;
    }

    const user = await User.create({
      name: ownerName,
      email: ownerEmail,
      phone: ownerPhone || undefined,
      password,
      role: "venue_owner",
      isPhoneVerified: true
    });
    createdUserId = user._id;

    const venue = await PartnerVenue.create({
      ...venueInput,
      slug: await uniqueSlug(venueInput.name),
      ownerName,
      ownerEmail,
      ownerPhone: ownerPhone || undefined,
      ownerUser: user._id,
      // Live for customers straight away; an admin can pause it or adjust commission in Settings.
      status: isAdminRole(req.user?.role) && venueInput.status ? venueInput.status : "published",
      createdBy: req.user?._id
    });
    user.partnerVenue = venue._id;
    await user.save();

    void sendVenueOwnerCredentialsEmail({ ownerName, ownerEmail, password, venueName: venue.name });
    logger.info(`[MARKETPLACE] ${req.user?.email} created venue ${venue.name} with owner ${ownerEmail}`);

    res.status(201).json({
      success: true,
      message: `${venue.name} created. Login details were emailed to ${ownerEmail}.`,
      venue,
      // Shown once so staff can pass it on if the email doesn't arrive.
      credentials: { email: ownerEmail, password }
    });
  } catch (error: any) {
    // Don't leave an orphan owner login if the venue failed to save.
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(() => undefined);
    if (error?.name === "ValidationError") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

/** PATCH /api/admin/marketplace/venues/:id — profile edits (commission fields ignored for staff). */
export const updatePartnerVenue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(req.params.id);
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }
    const isAdmin = isAdminRole(req.user?.role);
    if (!isAdmin && ADMIN_ONLY_FIELDS.some((f) => f in (req.body || {}))) {
      logger.warn(`[MARKETPLACE] Staff ${req.user?.email} tried to change commission on ${venue.name}; ignored`);
    }
    const updates = pickVenueFields(req.body || {}, isAdmin);
    if (updates.name && updates.name !== venue.name) updates.slug = await uniqueSlug(updates.name, String(venue._id));
    venue.set(updates);
    await venue.save();
    res.status(200).json({ success: true, venue });
  } catch (error: any) {
    if (error?.name === "ValidationError") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

/**
 * PATCH /api/admin/marketplace/venues/:id/commission  (admin/owner only)
 * body: { partnerDiscountPct, customerDiscountPct, depositPct, status? }
 */
export const setVenueCommission = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(req.params.id);
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }
    const b = req.body || {};
    const partner = num(b.partnerDiscountPct, 0, 100, venue.partnerDiscountPct);
    const customer = num(b.customerDiscountPct, 0, 100, venue.customerDiscountPct);
    if (customer > partner) {
      res.status(400).json({
        success: false,
        message: "The customer discount can't be bigger than the partner discount — Tropica would lose money on every booking."
      });
      return;
    }
    venue.partnerDiscountPct = partner;
    venue.customerDiscountPct = customer;
    venue.depositPct = num(b.depositPct, 1, 100, venue.depositPct);
    if (["draft", "published", "paused"].includes(b.status)) {
      if (b.status === "published" && venue.basePrice <= 0 && !venue.packages?.length) {
        res.status(400).json({ success: false, message: "Add a price or package before publishing this venue" });
        return;
      }
      venue.status = b.status;
    }
    await venue.save();
    logger.info(
      `[MARKETPLACE] ${req.user?.email} set ${venue.name} terms: partner ${partner}% / customer ${customer}% / deposit ${venue.depositPct}% / ${venue.status}`
    );
    const populated = await PartnerVenue.findById(venue._id).populate("ownerUser", "name email lastLoginAt").lean();
    res.status(200).json({ success: true, venue: toAdminRow(populated, {}) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/marketplace/venues/:id/owner/reset-password — new temp password, emailed. */
export const resetVenueOwnerPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findById(req.params.id);
    if (!venue?.ownerUser) {
      res.status(404).json({ success: false, message: "This venue has no owner login yet" });
      return;
    }
    const user = await User.findById(venue.ownerUser).select("+password");
    if (!user) {
      res.status(404).json({ success: false, message: "Owner account not found" });
      return;
    }
    const password = tempPassword();
    user.password = password;
    await user.save();
    void sendVenueOwnerCredentialsEmail({
      ownerName: user.name || venue.ownerName || "there",
      ownerEmail: user.email!,
      password,
      venueName: venue.name,
      isReset: true
    });
    res.status(200).json({ success: true, message: `New login details emailed to ${user.email}`, credentials: { email: user.email, password } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/marketplace/media  { imageBase64, kind: "logo"|"cover"|"flyer"|"photo" } */
export const uploadVenueMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { imageBase64 } = req.body || {};
    if (typeof imageBase64 !== "string" || !imageBase64.startsWith("data:image/")) {
      res.status(400).json({ success: false, message: "Please upload an image file" });
      return;
    }
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


/**
 * GET /api/admin/marketplace/revenue   (admin / owner)
 * Tropica's external revenue: commission earned from partner-venue bookings, overall and per venue.
 */
export const getExternalRevenue = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [report, byVenue, venues] = await Promise.all([
      buildReport({}),
      revenueByVenue(),
      PartnerVenue.find({}).select("name slug logoUrl theme status chargesEnabled partnerDiscountPct customerDiscountPct neighborhood").lean()
    ]);
    const rows = venues
      .map((v: any) => {
        const r = byVenue.get(String(v._id)) || {};
        return {
          _id: v._id,
          name: v.name,
          slug: v.slug,
          logoUrl: v.logoUrl,
          primary: v.theme?.primary,
          neighborhood: v.neighborhood,
          status: v.status,
          stripeConnected: Boolean(v.chargesEnabled),
          partnerDiscountPct: v.partnerDiscountPct,
          customerDiscountPct: v.customerDiscountPct,
          bookings: r.bookings || 0,
          gross: Math.round((r.gross || 0) * 100) / 100,
          collected: Math.round((r.collected || 0) * 100) / 100,
          commission: Math.round((r.commission || 0) * 100) / 100,
          payout: Math.round((r.payout || 0) * 100) / 100,
          pendingManualPayout: Math.round((r.pendingManualPayout || 0) * 100) / 100,
          lastBooking: r.lastBooking || null
        };
      })
      .sort((a, b) => b.commission - a.commission || b.gross - a.gross || a.name.localeCompare(b.name));

    res.status(200).json({
      success: true,
      totals: report.totals,
      thisMonth: report.thisMonth,
      lastMonth: report.lastMonth,
      monthly: report.monthly,
      venues: rows,
      recent: report.bookings.slice(0, 10)
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/marketplace/revenue/:id — one venue's revenue, month by month, with every paid booking. */
export const getVenueRevenue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = asObjectId(String(req.params.id));
    const venue = id
      ? await PartnerVenue.findById(id)
          .select("name slug logoUrl coverUrl theme status address neighborhood chargesEnabled stripeConnectAccountId partnerDiscountPct customerDiscountPct depositPct ownerName ownerEmail")
          .lean()
      : null;
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }
    const report = await buildReport({ venue: id });
    res.status(200).json({ success: true, venue, ...report });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/marketplace/bookings/:id/settle   (admin / owner)
 * body: { method: "stripe" | "manual", reference? }
 * Pays a venue its share of a booking Tropica collected (sent via Stripe, or recorded as paid another way).
 */
export const settleVenuePayout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const method = req.body?.method === "manual" ? "manual" : req.body?.method === "stripe" ? "stripe" : null;
    if (!method) {
      res.status(400).json({ success: false, message: "Choose how the venue was paid" });
      return;
    }
    const booking = await settleBooking(String(req.params.id), method, req.user!._id as any, sanitizeString(req.body.reference).slice(0, 200));
    res.status(200).json({
      success: true,
      message: method === "stripe" ? "Payout sent to the venue's Stripe account" : "Payout marked as paid",
      settlement: booking.settlement
    });
  } catch (err: any) {
    if (err instanceof PaymentError) {
      res.status(err.status).json({ success: false, message: err.message });
      return;
    }
    if (err?.type?.startsWith?.("Stripe")) {
      res.status(400).json({ success: false, message: `Stripe: ${err.message}` });
      return;
    }
    next(err);
  }
};

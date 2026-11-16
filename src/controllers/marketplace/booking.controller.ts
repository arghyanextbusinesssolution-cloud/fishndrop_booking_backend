import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import MarketplaceBooking, { IMarketplaceBooking } from "../../models/MarketplaceBooking";
import PartnerVenue from "../../models/PartnerVenue";
import logger from "../../config/logger";
import { availableSlots, isValidSessionDate } from "../../services/marketplace/availability.service";
import { computeBreakdown, regularPriceFor } from "../../services/marketplace/pricing.service";
import { notifyRequestCreated } from "../../services/marketplace/notifications.service";
import { PaymentError, createPaymentIntentFor, verifyAndFulfill } from "../../services/marketplace/payment.service";
import { sanitizeString } from "../../utils/time.utils";

const newBookingNumber = () => `TV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

/** Customer view of a request — hides the venue payout and Tropica's commission. */
export const toCustomerBooking = (b: IMarketplaceBooking) => {
  const obj = b.toObject();
  delete obj.venuePayout;
  delete obj.commission;
  delete obj.settlement;
  delete obj.confirmationClaimed;
  delete obj.ownerReminderSentAt;
  delete obj.staffEscalatedAt;
  obj.payments = (obj.payments || []).map(({ applicationFee: _fee, connectAccountId: _acct, ...p }: any) => p);
  return obj;
};

/**
 * POST /api/marketplace/requests  (logged-in customer)
 * body: { venueSlug, date: YYYY-MM-DD, startTime: HH:MM, hours?, packageId?, guests,
 *         customerName?, customerEmail?, customerPhone?, occasion?, birthday?, notes? }
 */
export const createBookingRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Please log in to request a booking" });
      return;
    }
    const venue = await PartnerVenue.findOne({ slug: String(req.body.venueSlug || "").toLowerCase(), status: "published" });
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }

    const date = String(req.body.date || "");
    const startTime = String(req.body.startTime || "");
    const guests = Math.floor(Number(req.body.guests));
    if (!isValidSessionDate(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
      res.status(400).json({ success: false, message: "A valid date and start time are required" });
      return;
    }
    if (!guests || guests < venue.minGuests || guests > venue.maxGuests) {
      res.status(400).json({
        success: false,
        message: `${venue.name} hosts ${venue.minGuests}–${venue.maxGuests} guests`
      });
      return;
    }

    const packageId = req.body.packageId ? String(req.body.packageId) : undefined;
    const priced = regularPriceFor(venue, Number(req.body.hours) || venue.minHours, packageId);
    const slot = (await availableSlots(venue, date, priced.hours)).find((s) => s.startTime === startTime);
    if (!slot) {
      res.status(409).json({ success: false, message: "That time is no longer available. Please pick another slot." });
      return;
    }

    // Don't let one customer stack duplicate open requests for the same slot.
    const duplicate = await MarketplaceBooking.findOne({
      user: req.user._id,
      venue: venue._id,
      date,
      startMin: slot.startMin,
      status: { $in: ["requested", "availability_confirmed"] }
    });
    if (duplicate) {
      res.status(200).json({ success: true, duplicate: true, booking: toCustomerBooking(duplicate) });
      return;
    }

    const price = computeBreakdown(priced.regularPrice, venue);
    const customerName = sanitizeString(req.body.customerName) || req.user.name || "";
    const customerEmail = (sanitizeString(req.body.customerEmail) || req.user.email || "").toLowerCase();
    const customerPhone = sanitizeString(req.body.customerPhone) || req.user.phone || "";
    if (!customerName || !customerEmail || !customerPhone) {
      res.status(400).json({ success: false, message: "Name, email and phone are required" });
      return;
    }

    const booking = await MarketplaceBooking.create({
      bookingNumber: newBookingNumber(),
      user: req.user._id,
      venue: venue._id,
      venueName: venue.name,
      date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      startMin: slot.startMin,
      endMin: slot.endMin,
      durationHours: priced.hours,
      guests,
      packageId: packageId && priced.packageName ? packageId : undefined,
      packageName: priced.packageName,
      customerName,
      customerEmail,
      customerPhone,
      occasion: sanitizeString(req.body.occasion) || undefined,
      birthday: sanitizeString(req.body.birthday) || undefined,
      notes: sanitizeString(req.body.notes).slice(0, 2000) || undefined,
      status: "requested",
      ...price,
      amountPaid: 0,
      settlement: { mode: venue.chargesEnabled && venue.stripeConnectAccountId ? "connect" : "manual", status: "pending" }
    });

    logger.info(`[MARKETPLACE] Request ${booking.bookingNumber} for ${venue.name} on ${date} ${slot.startTime} by ${req.user.id}`);
    notifyRequestCreated(booking, venue);

    res.status(201).json({ success: true, booking: toCustomerBooking(booking) });
  } catch (error) {
    next(error);
  }
};

const sendPaymentError = (res: Response, err: unknown, next: NextFunction) => {
  if (err instanceof PaymentError) {
    res.status(err.status).json({ success: false, message: err.message });
    return;
  }
  next(err);
};

/** POST /api/marketplace/requests/:id/pay — PaymentIntent for the deposit/full price or the balance. */
export const createBookingPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = await MarketplaceBooking.findOne({ _id: req.params.id, user: req.user!._id });
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    const intent = await createPaymentIntentFor(booking);
    res.status(200).json({ success: true, ...intent, bookingNumber: booking.bookingNumber });
  } catch (err) {
    sendPaymentError(res, err, next);
  }
};

/** POST /api/marketplace/requests/:id/verify-payment  { paymentIntentId } — confirm right after Stripe succeeds. */
export const verifyBookingPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = await MarketplaceBooking.findOne({ _id: req.params.id, user: req.user!._id });
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    const paymentIntentId = String(req.body?.paymentIntentId || booking.stripePaymentIntentId || "");
    if (!paymentIntentId) {
      res.status(400).json({ success: false, message: "Missing payment reference" });
      return;
    }
    const result = await verifyAndFulfill(booking, paymentIntentId);
    const fresh = await MarketplaceBooking.findById(booking._id).populate("venue", "name slug coverUrl logoUrl theme address");
    res.status(200).json({ success: true, status: result.status, booking: fresh ? toCustomerBooking(fresh) : null });
  } catch (err) {
    sendPaymentError(res, err, next);
  }
};

/** GET /api/marketplace/requests/my */
export const getMyBookingRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookings = await MarketplaceBooking.find({ user: req.user!._id })
      .sort({ createdAt: -1 })
      .populate("venue", "name slug coverUrl logoUrl theme address");
    res.status(200).json({ success: true, bookings: bookings.map(toCustomerBooking) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/marketplace/requests/:id */
export const getMyBookingRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = await MarketplaceBooking.findOne({ _id: req.params.id, user: req.user!._id }).populate(
      "venue",
      "name slug coverUrl logoUrl flyerUrl theme address cancellationPolicy"
    );
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(200).json({ success: true, booking: toCustomerBooking(booking) });
  } catch (error) {
    next(error);
  }
};

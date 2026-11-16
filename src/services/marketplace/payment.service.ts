import crypto from "crypto";
import MarketplaceBooking, { IMarketplaceBooking } from "../../models/MarketplaceBooking";
import PartnerVenue, { IPartnerVenue } from "../../models/PartnerVenue";
import VenueBlock from "../../models/VenueBlock";
import logger from "../../config/logger";
import { getStripe } from "../../utils/stripe.utils";
import { applicationFeeFor, round2, splitAtCurrentRate } from "./pricing.service";
import { isRangeFree } from "./availability.service";
import { notifyBookingConfirmed, notifyBalancePaid, notifySlotLostRefund } from "./notifications.service";

/**
 * Marketplace payments (Stripe PaymentIntents, destination charges when the venue has Connect).
 *
 *  first payment  → deposit (or full price when depositPct = 100) → booking confirmed + slot blocked
 *  second payment → remaining balance
 *
 * Fulfilment is idempotent (keyed on the PaymentIntent id) and runs from both the browser
 * ("verify") and the Stripe webhook, whichever arrives first.
 */

export type PaymentKind = "deposit" | "full" | "balance";

export class PaymentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const collectedFees = (b: IMarketplaceBooking) => round2((b.payments || []).reduce((s, p) => s + (p.applicationFee || 0), 0));

/** What the customer owes right now, or an error explaining why they can't pay. */
export const amountDue = (b: IMarketplaceBooking): { amount: number; kind: PaymentKind } => {
  if (b.status === "availability_confirmed") {
    if (b.paymentLinkExpiresAt && b.paymentLinkExpiresAt.getTime() < Date.now()) {
      throw new PaymentError(410, "This payment link has expired. Please send a new request.");
    }
    const full = b.depositAmount >= b.customerPrice - 0.005;
    return { amount: round2(full ? b.customerPrice : b.depositAmount), kind: full ? "full" : "deposit" };
  }
  if (b.status === "deposit_paid" && b.remainingAmount > 0) {
    return { amount: round2(b.remainingAmount), kind: "balance" };
  }
  if (b.status === "requested") throw new PaymentError(409, "The venue hasn't confirmed your date yet.");
  if (b.status === "paid") throw new PaymentError(409, "This booking is already paid in full.");
  throw new PaymentError(409, `This booking can't be paid (${b.status.replace(/_/g, " ")}).`);
};

/** Ask Stripe live whether the venue can receive destination charges (cached flag can lag). */
export const venueConnectAccount = async (venue: IPartnerVenue): Promise<string | null> => {
  const stripe = getStripe();
  const acct = venue.stripeConnectAccountId;
  if (!stripe || !acct || acct.startsWith("acct_test_")) return null;
  try {
    const a = await stripe.accounts.retrieve(acct);
    const ok = Boolean(a.charges_enabled && a.capabilities?.transfers === "active");
    if (ok !== venue.chargesEnabled) await PartnerVenue.updateOne({ _id: venue._id }, { $set: { chargesEnabled: ok } });
    return ok ? acct : null;
  } catch (err: any) {
    logger.warn(`[MARKETPLACE] Could not verify Connect account ${acct}; Tropica collects this payment`, { error: err.message });
    return null;
  }
};

/** Create (or reuse) a PaymentIntent for what's currently due. */
export const createPaymentIntentFor = async (booking: IMarketplaceBooking) => {
  const stripe = getStripe();
  if (!stripe) throw new PaymentError(503, "Online payment isn't configured on the server yet.");

  const { amount, kind } = amountDue(booking);
  if (amount < 0.5) throw new PaymentError(400, "Nothing to pay right now.");

  // First payment: make sure nobody else has taken the time since the venue confirmed.
  if (kind !== "balance" && !(await isRangeFree(booking.venue, booking.date, booking.startMin, booking.endMin, String(booking._id)))) {
    throw new PaymentError(409, "Sorry — this time was just booked by someone else. Please pick another slot.");
  }

  const venue = await PartnerVenue.findById(booking.venue);
  if (!venue) throw new PaymentError(404, "Venue not found");

  // First payment: the commission the admin currently has set for this venue applies.
  const alreadyPaid = (booking.payments || []).some((p) => p.status === "succeeded");
  if (!alreadyPaid && !booking.priceOverridden) {
    const split = splitAtCurrentRate(booking.regularPrice, booking.customerPrice, venue.partnerDiscountPct);
    if (split.venuePayout !== booking.venuePayout || split.commission !== booking.commission) {
      logger.info(`[MARKETPLACE] ${booking.bookingNumber}: venue payout ${booking.venuePayout} → ${split.venuePayout} at ${venue.partnerDiscountPct}% partner rate`);
      booking.venuePayout = split.venuePayout;
      booking.commission = split.commission;
    }
  }

  const isFinal = kind !== "deposit";
  const fee = applicationFeeFor(amount, booking, collectedFees(booking), isFinal);
  const destination = await venueConnectAccount(venue);

  const params: Record<string, any> = {
    amount: Math.round(amount * 100),
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    receipt_email: booking.customerEmail,
    description: `${venue.name} — ${booking.date} ${booking.startTime}–${booking.endTime} — ${booking.bookingNumber} (${kind})`,
    metadata: {
      type: "marketplace_booking",
      bookingId: String(booking._id),
      bookingNumber: booking.bookingNumber,
      paymentKind: kind,
      applicationFee: String(fee),
      venueId: String(venue._id)
    }
  };
  if (destination) {
    params.application_fee_amount = Math.round(fee * 100);
    params.transfer_data = { destination };
    params.metadata.connectAccountId = destination;
  }

  // Reuse an open intent for the same amount (customer reopened the dialog) instead of creating another.
  if (booking.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(booking.stripePaymentIntentId);
      const reusable =
        existing.metadata?.paymentKind === kind &&
        existing.amount === params.amount &&
        ["requires_payment_method", "requires_confirmation", "requires_action"].includes(existing.status) &&
        (existing.transfer_data?.destination || null) === (destination || null) &&
        (existing.application_fee_amount ?? null) === (params.application_fee_amount ?? null);
      if (reusable) return { clientSecret: existing.client_secret!, amount, kind, paymentIntentId: existing.id };
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(existing.status)) {
        await stripe.paymentIntents.cancel(existing.id).catch(() => undefined);
      }
    } catch {
      /* stale id — create a new one */
    }
  }

  const intent = await stripe.paymentIntents.create(params as any, {
    idempotencyKey: `mkt-${booking._id}-${kind}-${params.amount}-${destination || "platform"}-${(booking.payments || []).length}`
  });
  booking.stripePaymentIntentId = intent.id;
  await booking.save();
  logger.info(`[MARKETPLACE] PaymentIntent ${intent.id} for ${booking.bookingNumber}: $${amount} (${kind}), fee $${fee}${destination ? ` → ${destination}` : " (platform)"}`);
  return { clientSecret: intent.client_secret!, amount, kind, paymentIntentId: intent.id };
};

/**
 * Record a succeeded PaymentIntent against its booking. Safe to call many times.
 * Returns the updated booking (or null when the intent isn't a marketplace payment).
 */
export const fulfillMarketplacePayment = async (intent: any): Promise<IMarketplaceBooking | null> => {
  if (intent?.metadata?.type !== "marketplace_booking" || intent.status !== "succeeded") return null;
  const bookingId = intent.metadata.bookingId;
  const kind = intent.metadata.paymentKind as PaymentKind;
  const paid = round2((intent.amount_received ?? intent.amount) / 100);
  const fee = intent.application_fee_amount ? round2(intent.application_fee_amount / 100) : Number(intent.metadata.applicationFee || 0);
  const connectAccountId: string | undefined = intent.transfer_data?.destination || undefined;

  // Atomic "record once": only the first caller pushes this transaction id.
  const booking = await MarketplaceBooking.findOneAndUpdate(
    { _id: bookingId, "payments.transactionId": { $ne: intent.id } },
    {
      $push: {
        payments: {
          amount: paid,
          applicationFee: connectAccountId ? fee : 0,
          paymentType: kind,
          status: "succeeded",
          transactionId: intent.id,
          connectAccountId,
          paidAt: new Date()
        }
      },
      $inc: { amountPaid: paid }
    },
    { new: true }
  );
  if (!booking) return MarketplaceBooking.findById(bookingId); // already recorded

  const venue = await PartnerVenue.findById(booking.venue);
  booking.remainingAmount = round2(Math.max(0, booking.customerPrice - booking.amountPaid));
  const fullyPaid = booking.remainingAmount <= 0.005;

  if (kind === "balance") {
    booking.status = fullyPaid ? "paid" : "deposit_paid";
  } else {
    // First payment: claim the time slot on the venue's calendar.
    const lost = await claimSlot(booking);
    if (lost) {
      await refundLostSlot(booking, intent.id, paid, Boolean(connectAccountId));
      if (venue) notifySlotLostRefund(booking, venue);
      return booking;
    }
    booking.status = fullyPaid ? "paid" : "deposit_paid";
    booking.confirmedAt = new Date();
    // The booking is now a celebration: give it a shareable guest invite link.
    if (!booking.invitationToken) booking.invitationToken = crypto.randomBytes(16).toString("hex");
  }

  // Settled only when every payment reached the venue (paid via Connect, or transferred later by Tropica).
  const everyPaymentReachedVenue = (booking.payments || [])
    .filter((p) => p.status === "succeeded")
    .every((p) => p.connectAccountId || p.transferId);
  booking.settlement = {
    ...(booking.settlement || {}),
    mode: connectAccountId ? "connect" : booking.settlement?.mode === "connect" ? "connect" : "manual",
    status: fullyPaid && everyPaymentReachedVenue ? "transferred" : booking.settlement?.status || "pending"
  } as any;
  await booking.save();

  logger.info(`[MARKETPLACE] ${booking.bookingNumber} paid ${paid} (${kind}) → ${booking.status}`);
  // Tropica collected this one (venue not on Connect at that moment): send the venue its share if it can receive it.
  if (!connectAccountId) {
    void import("./settlement.service").then((m) => m.autoSettleVenue(booking.venue)).catch(() => undefined);
  }
  if (venue) {
    if (kind === "balance") notifyBalancePaid(booking, venue);
    else notifyBookingConfirmed(booking, venue);
  }
  return booking;
};

/** Create the booking's calendar block; returns true when another booking got there first. */
const claimSlot = async (booking: IMarketplaceBooking): Promise<boolean> => {
  if (!(await isRangeFree(booking.venue, booking.date, booking.startMin, booking.endMin, String(booking._id)))) return true;
  let mine;
  try {
    mine = await VenueBlock.create({
      venue: booking.venue,
      date: booking.date,
      startMin: booking.startMin,
      endMin: booking.endMin,
      reason: "booking",
      booking: booking._id
    });
  } catch (err: any) {
    if (err?.code === 11000) return false; // block for this booking already exists (retry)
    throw err;
  }
  // Two payments in the same instant: the earlier block wins.
  const rival = await VenueBlock.findOne({
    _id: { $lt: mine._id },
    venue: booking.venue,
    date: booking.date,
    startMin: { $lt: booking.endMin },
    endMin: { $gt: booking.startMin }
  }).lean();
  if (rival) {
    await VenueBlock.deleteOne({ _id: mine._id });
    return true;
  }
  return false;
};

const refundLostSlot = async (booking: IMarketplaceBooking, intentId: string, amount: number, connect: boolean) => {
  const stripe = getStripe();
  let refundId: string | undefined;
  try {
    const refund = await stripe!.refunds.create({
      payment_intent: intentId,
      ...(connect ? { reverse_transfer: true, refund_application_fee: true } : {})
    });
    refundId = refund.id;
  } catch (err: any) {
    logger.error(`[MARKETPLACE] Auto-refund failed for ${booking.bookingNumber} — refund manually!`, { error: err.message });
  }
  booking.refunds.push({ amount, stripeRefundId: refundId, reason: "Time slot was taken by another booking", createdAt: new Date() });
  booking.payments = booking.payments.map((p) => (p.transactionId === intentId ? { ...((p as any).toObject?.() ?? p), status: "refunded" } : p)) as any;
  booking.amountPaid = round2(Math.max(0, booking.amountPaid - amount));
  booking.status = "cancelled";
  booking.cancelReason = "Another customer booked this time moments before your payment. You've been refunded in full.";
  booking.cancelledAt = new Date();
  await booking.save();
  logger.warn(`[MARKETPLACE] ${booking.bookingNumber} lost its slot to another booking — refunded $${amount}`);
};

/** Browser callback after Stripe confirms: fetch the intent and fulfil it right away. */
export const verifyAndFulfill = async (booking: IMarketplaceBooking, paymentIntentId: string) => {
  const stripe = getStripe();
  if (!stripe) throw new PaymentError(503, "Online payment isn't configured on the server yet.");
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (intent.metadata?.bookingId !== String(booking._id)) throw new PaymentError(400, "This payment doesn't belong to this booking.");
  if (intent.status === "processing") return { status: "processing" as const, booking };
  if (intent.status !== "succeeded") throw new PaymentError(402, "The payment hasn't gone through yet.");
  const updated = await fulfillMarketplacePayment(intent);
  return { status: "succeeded" as const, booking: updated || booking };
};

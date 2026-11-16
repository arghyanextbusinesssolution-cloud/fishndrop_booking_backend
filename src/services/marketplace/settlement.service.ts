import { Types } from "mongoose";
import MarketplaceBooking, { IMarketplaceBooking } from "../../models/MarketplaceBooking";
import PartnerVenue from "../../models/PartnerVenue";
import logger from "../../config/logger";
import { getStripe } from "../../utils/stripe.utils";
import { round2, splitAtCurrentRate } from "./pricing.service";
import { PaymentError, venueConnectAccount } from "./payment.service";
import { EARNING_STATUSES } from "./report.service";

/**
 * Paying a venue its share when Tropica collected the money itself
 * (the venue wasn't on Stripe Connect yet when the customer paid).
 *
 *  - "stripe": transfer the venue's share of each Tropica-collected payment to its connected account
 *              (tied to the original charge with source_transaction, idempotent per payment)
 *  - "manual": Tropica paid outside Stripe (bank transfer, Zelle…) — just record it
 */

/** Venue's share of one payment, in proportion to the booking's payout / price. */
const venueShareOf = (amount: number, b: IMarketplaceBooking) => (b.customerPrice > 0 ? round2((amount * b.venuePayout) / b.customerPrice) : 0);

/** Payments Tropica collected that still need to reach the venue. */
export const untransferredPayments = (b: IMarketplaceBooking) =>
  (b.payments || []).filter((p) => p.status === "succeeded" && !p.connectAccountId && !p.transferId);

export const amountOwedToVenue = (b: IMarketplaceBooking) => round2(untransferredPayments(b).reduce((s, p) => s + venueShareOf(p.amount, b), 0));

export const settleBooking = async (bookingId: string, method: "stripe" | "manual", adminId?: Types.ObjectId, reference?: string) => {
  const booking = await MarketplaceBooking.findById(bookingId);
  if (!booking) throw new PaymentError(404, "Booking not found");
  if (!EARNING_STATUSES.includes(booking.status)) throw new PaymentError(409, "Only paid bookings can be settled.");
  if (["transferred", "paid_manually"].includes(booking.settlement?.status)) throw new PaymentError(409, "This booking is already settled.");

  const pending = untransferredPayments(booking);

  if (method === "manual") {
    booking.settlement = {
      ...(booking.settlement as any),
      mode: "manual",
      status: "paid_manually",
      paidAt: new Date(),
      reference: reference || undefined,
      settledBy: adminId
    };
    await booking.save();
    logger.info(`[MARKETPLACE] ${booking.bookingNumber} payout marked as paid manually by ${adminId}${reference ? ` (${reference})` : ""}`);
    return booking;
  }

  // Stripe transfer to the venue's connected account
  const stripe = getStripe();
  if (!stripe) throw new PaymentError(503, "Stripe isn't configured on the server.");
  if (!pending.length) throw new PaymentError(409, "Nothing left to send — every payment already reached the venue.");
  const venue = await PartnerVenue.findById(booking.venue);
  if (!venue) throw new PaymentError(404, "Venue not found");
  const destination = await venueConnectAccount(venue);
  if (!destination) throw new PaymentError(409, `${venue.name} hasn't finished connecting Stripe. Use "Mark paid manually" if you paid them another way.`);

  let sent = 0;
  for (const p of pending) {
    const share = venueShareOf(p.amount, booking);
    if (share <= 0) continue;
    const intent = await stripe.paymentIntents.retrieve(p.transactionId);
    const charge = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
    if (!charge) throw new PaymentError(409, `Couldn't find the Stripe charge for payment ${p.transactionId}.`);
    const transfer = await stripe.transfers.create(
      {
        amount: Math.round(share * 100),
        currency: "usd",
        destination,
        source_transaction: charge,
        transfer_group: booking.bookingNumber,
        description: `${venue.name} payout — ${booking.bookingNumber} (${booking.date})`,
        metadata: { type: "marketplace_settlement", bookingId: String(booking._id), paymentIntent: p.transactionId }
      },
      { idempotencyKey: `mkt-settle-${p.transactionId}-${destination}` }
    );
    p.transferId = transfer.id;
    p.transferredAmount = share;
    sent += share;
    logger.info(`[MARKETPLACE] Transferred $${share} to ${destination} for ${booking.bookingNumber} (${transfer.id})`);
  }
  booking.markModified("payments");

  const fullyPaid = booking.remainingAmount <= 0.005;
  booking.settlement = {
    ...(booking.settlement as any),
    status: fullyPaid ? "transferred" : "pending",
    paidAt: fullyPaid ? new Date() : booking.settlement?.paidAt,
    transferredAmount: round2((booking.settlement?.transferredAmount || 0) + sent),
    settledBy: adminId
  };
  await booking.save();
  return booking;
};

const running = new Set<string>();

/**
 * Pay a venue everything Tropica is holding for it, minus Tropica's commission, as soon as the venue
 * can receive Stripe transfers. Runs on its own — after a payment, when the venue connects Stripe, and
 * when the owner opens Stripe & Payouts. Safe to call repeatedly (transfers are idempotent per payment).
 */
export const autoSettleVenue = async (venueId: Types.ObjectId | string): Promise<{ count: number; amount: number }> => {
  const key = String(venueId);
  if (running.has(key) || !getStripe()) return { count: 0, amount: 0 };
  running.add(key);
  try {
    const venue = await PartnerVenue.findById(venueId);
    if (!venue || !(await venueConnectAccount(venue))) return { count: 0, amount: 0 };

    const bookings = await MarketplaceBooking.find({
      venue: venue._id,
      status: { $in: EARNING_STATUSES },
      "settlement.status": "pending",
      payments: { $elemMatch: { status: "succeeded", connectAccountId: { $in: [null, ""] }, transferId: { $in: [null, ""] } } }
    });

    let count = 0;
    let amount = 0;
    for (const b of bookings) {
      try {
        // Nothing sent yet: use the commission the admin has set for this venue now.
        const nothingSentYet = !(b.payments || []).some((p) => p.transferId);
        if (nothingSentYet && !b.priceOverridden) {
          const split = splitAtCurrentRate(b.regularPrice, b.customerPrice, venue.partnerDiscountPct);
          if (split.venuePayout !== b.venuePayout) {
            await MarketplaceBooking.updateOne({ _id: b._id }, { $set: { venuePayout: split.venuePayout, commission: split.commission } });
          }
        }
        const owed = amountOwedToVenue(await MarketplaceBooking.findById(b._id).orFail());
        await settleBooking(String(b._id), "stripe");
        count += 1;
        amount += owed;
      } catch (err: any) {
        logger.warn(`[MARKETPLACE] Auto-payout failed for ${b.bookingNumber}: ${err.message}`);
      }
    }
    if (count) logger.info(`[MARKETPLACE] Auto-paid ${venue.name} $${round2(amount)} for ${count} booking(s)`);
    return { count, amount: round2(amount) };
  } finally {
    running.delete(key);
  }
};

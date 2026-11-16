import { Types } from "mongoose";
import MarketplaceBooking from "../../models/MarketplaceBooking";
import { round2 } from "./pricing.service";
import { nyTodayAndNow } from "./availability.service";

/**
 * Money reports for partner venues.
 *  - owner view: what the venue earns (payout) per month
 *  - admin view: Tropica's external revenue (commission) across all partner venues
 *
 * Bookings count once they are paid (deposit or full); amounts are bucketed by event month.
 */

export const EARNING_STATUSES = ["deposit_paid", "paid", "completed"];

export interface MonthRow {
  month: string; // YYYY-MM
  bookings: number;
  gross: number; // customer price of the bookings (what customers pay in total)
  collected: number; // customer money actually received so far
  commission: number; // Tropica's share
  payout: number; // the venue's share
  upcoming: boolean; // month is after the current month
}

export interface ReportTotals {
  bookings: number;
  guests: number;
  gross: number;
  collected: number;
  outstanding: number; // balances customers still owe
  commission: number;
  payout: number;
  payoutSettled: number; // sent via Stripe or paid manually
  payoutPending: number;
  pendingManualPayout: number; // Tropica still has to pay the venue by hand
  refunds: number;
  upcomingBookings: number;
  upcomingPayout: number;
}

const monthKey = (ymd: string) => ymd.slice(0, 7);

const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

const isSettled = (b: any) => ["transferred", "paid_manually"].includes(b.settlement?.status);

/** Load the paid bookings (plus refunded/cancelled ones for the refund total) that match `filter`. */
const loadBookings = (filter: Record<string, unknown>) =>
  MarketplaceBooking.find({ ...filter, $or: [{ status: { $in: EARNING_STATUSES } }, { "refunds.0": { $exists: true } }] })
    .select("venue venueName bookingNumber date startTime endTime guests status customerName customerPrice amountPaid remainingAmount commission venuePayout settlement refunds occasion payments")
    .lean();

export const buildReport = async (filter: Record<string, unknown>, monthsBack = 8, monthsAhead = 3) => {
  const { today } = nyTodayAndNow();
  const thisMonth = monthKey(today);
  const rows = await loadBookings(filter);
  const earning = rows.filter((b: any) => EARNING_STATUSES.includes(b.status));

  // Month window: a fixed span around today, widened to include any booking outside it.
  let first = shiftMonth(thisMonth, -monthsBack);
  let last = shiftMonth(thisMonth, monthsAhead);
  for (const b of earning) {
    const k = monthKey(b.date);
    if (k < first) first = k;
    if (k > last) last = k;
  }
  const months = new Map<string, MonthRow>();
  for (let k = first; k <= last; k = shiftMonth(k, 1)) {
    months.set(k, { month: k, bookings: 0, gross: 0, collected: 0, commission: 0, payout: 0, upcoming: k > thisMonth });
  }

  const totals: ReportTotals = {
    bookings: 0,
    guests: 0,
    gross: 0,
    collected: 0,
    outstanding: 0,
    commission: 0,
    payout: 0,
    payoutSettled: 0,
    payoutPending: 0,
    pendingManualPayout: 0,
    refunds: 0,
    upcomingBookings: 0,
    upcomingPayout: 0
  };

  for (const b of rows as any[]) totals.refunds += (b.refunds || []).reduce((s: number, r: any) => s + (r.amount || 0), 0);

  for (const b of earning as any[]) {
    const m = months.get(monthKey(b.date))!;
    m.bookings += 1;
    m.gross += b.customerPrice;
    m.collected += b.amountPaid;
    m.commission += b.commission;
    m.payout += b.venuePayout;

    totals.bookings += 1;
    totals.guests += b.guests || 0;
    totals.gross += b.customerPrice;
    totals.collected += b.amountPaid;
    totals.outstanding += b.remainingAmount || 0;
    totals.commission += b.commission;
    totals.payout += b.venuePayout;
    if (isSettled(b)) totals.payoutSettled += b.venuePayout;
    else {
      totals.payoutPending += b.venuePayout;
      if (b.settlement?.mode !== "connect") totals.pendingManualPayout += b.venuePayout;
    }
    if (b.date >= today) {
      totals.upcomingBookings += 1;
      totals.upcomingPayout += b.venuePayout;
    }
  }

  const monthly = [...months.values()].map((m) => ({
    ...m,
    gross: round2(m.gross),
    collected: round2(m.collected),
    commission: round2(m.commission),
    payout: round2(m.payout)
  }));
  for (const k of Object.keys(totals) as (keyof ReportTotals)[]) totals[k] = round2(totals[k]);

  const cur = months.get(thisMonth);
  const prev = months.get(shiftMonth(thisMonth, -1));
  return {
    totals,
    monthly,
    thisMonth: { month: thisMonth, payout: round2(cur?.payout || 0), commission: round2(cur?.commission || 0), bookings: cur?.bookings || 0 },
    lastMonth: { payout: round2(prev?.payout || 0), commission: round2(prev?.commission || 0), bookings: prev?.bookings || 0 },
    bookings: earning
      .sort((a: any, b: any) => (b.date + b.startTime).localeCompare(a.date + a.startTime))
      .map((b: any) => ({
        _id: b._id,
        bookingNumber: b.bookingNumber,
        venue: b.venue,
        venueName: b.venueName,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        guests: b.guests,
        occasion: b.occasion,
        status: b.status,
        customerName: b.customerName,
        customerPrice: b.customerPrice,
        amountPaid: b.amountPaid,
        remainingAmount: b.remainingAmount,
        commission: b.commission,
        venuePayout: b.venuePayout,
        settlement: b.settlement,
        // Venue share of payments Tropica collected and has not passed on yet
        owedToVenue: ["transferred", "paid_manually"].includes(b.settlement?.status)
          ? 0
          : round2(
              (b.payments || [])
                .filter((p: any) => p.status === "succeeded" && !p.connectAccountId && !p.transferId)
                .reduce((s: number, p: any) => s + (b.customerPrice > 0 ? (p.amount * b.venuePayout) / b.customerPrice : 0), 0)
            )
      }))
  };
};

/** Per-venue revenue rows for the admin overview. */
export const revenueByVenue = async () => {
  const rows = await MarketplaceBooking.aggregate([
    { $match: { status: { $in: EARNING_STATUSES } } },
    {
      $group: {
        _id: "$venue",
        bookings: { $sum: 1 },
        gross: { $sum: "$customerPrice" },
        collected: { $sum: "$amountPaid" },
        commission: { $sum: "$commission" },
        payout: { $sum: "$venuePayout" },
        pendingManualPayout: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ["$settlement.mode", "connect"] }, { $not: [{ $in: ["$settlement.status", ["transferred", "paid_manually"]] }] }] },
              "$venuePayout",
              0
            ]
          }
        },
        lastBooking: { $max: "$date" }
      }
    }
  ]);
  return new Map(rows.map((r: any) => [String(r._id), r]));
};

export const asObjectId = (id: string) => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null);

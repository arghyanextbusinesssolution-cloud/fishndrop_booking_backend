import logger from "../../../../config/logger";
import { safeTrigger } from "../../client";
import { VENUE_NAME, VENUE_TIMEZONE } from "../../config";
import { calculateEventTimes, parseTimeString, toDateOnly } from "../../helpers/time";

/** How far ahead availability is published to GHL. */
const WINDOW_DAYS = 90;
/** Each bookable slot is 2 hours long (matches createSlotLocksForPrivateEvent / isOverlapping). */
const SLOT_MINUTES = 120;
/** Collapse bursts (a private party writes 3–5 locks at once) into one webhook. */
const DEBOUNCE_MS = 5_000;

type BlockType = "private_party" | "admin_block";

interface BlockedRange {
  from: string; // "20:00"
  to: string; // "01:00"
  fromLabel: string; // "8:00 PM"
  toLabel: string; // "1:00 AM"
  type: BlockType;
  note: string;
}

interface BlockedDay {
  date: string; // "2026-12-30"
  dateLabel: string; // "Wed, Dec 30, 2026"
  blocked: BlockedRange[];
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** Minutes from the start of the "venue night" — times before 08:00 belong to the previous evening. */
const nightMinutes = (time: string) => {
  const { hours, minutes } = parseTimeString(time);
  return (hours < 8 ? hours + 24 : hours) * 60 + minutes;
};
const fromNightMinutes = (m: number) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
const label12 = (hhmm: string) => calculateEventTimes("", hhmm, 0).eventStartTime;

const dateLabel = (dateOnly: string) => {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: VENUE_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
};

/** Today's date in New York as "YYYY-MM-DD". */
const todayNy = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: VENUE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/**
 * Builds the next-90-days list of blocked time ranges at the venue.
 * Sources: confirmed / paid private bookings (exact start + duration) and SlotLock rows
 * (admin blocks, plus locks held by private bookings still awaiting payment).
 * Contains NO customer details — this data is shared with every chat.
 */
export const buildAvailabilitySnapshot = async () => {
  // Lazy requires: the models' hooks import this file
  const Booking = require("../../../../models/Booking").default;
  const SlotLock = require("../../../../models/SlotLock").default;
  const SystemSettings = require("../../../../models/SystemSettings").default;

  const startDate = todayNy();
  const from = new Date(`${startDate}T00:00:00.000Z`);
  const to = new Date(from.getTime() + WINDOW_DAYS * 86_400_000);

  const [locks, parties, settings] = await Promise.all([
    SlotLock.find({ isLocked: true, bookingDate: { $gte: from, $lt: to } }).lean(),
    Booking.find({
      bookingType: "private_event",
      status: { $ne: "cancelled" },
      $or: [{ status: "confirmed" }, { paymentStatus: { $in: ["deposit_paid", "paid"] } }],
      bookingDate: { $gte: from, $lt: to }
    })
      .select("bookingDate bookingTime durationHours status")
      .lean(),
    SystemSettings.getSettings().catch(() => null)
  ]);

  // date → list of [startMin, endMin, type]
  const byDate = new Map<string, Array<{ start: number; end: number; type: BlockType }>>();
  const add = (date: string, start: number, end: number, type: BlockType) => {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ start, end, type });
  };

  const partyIds = new Set<string>();
  for (const p of parties) {
    partyIds.add(String(p._id));
    const start = nightMinutes(p.bookingTime || "20:00");
    add(toDateOnly(p.bookingDate), start, start + Math.round((Number(p.durationHours) || 5) * 60), "private_party");
  }
  for (const l of locks) {
    // Locks belonging to a confirmed party are already covered with its exact window
    if (l.eventId && partyIds.has(String(l.eventId))) continue;
    const start = nightMinutes(l.bookingTime);
    add(toDateOnly(l.bookingDate), start, start + SLOT_MINUTES, l.eventId ? "private_party" : "admin_block");
  }

  // Merge overlapping / touching ranges of the same type per date
  const days: BlockedDay[] = [...byDate.keys()].sort().map((date) => {
    const ranges = byDate.get(date)!.sort((a, b) => a.start - b.start);
    const merged: typeof ranges = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && last.type === r.type && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    return {
      date,
      dateLabel: dateLabel(date),
      blocked: merged.map((r) => {
        const fromT = fromNightMinutes(r.start);
        const toT = fromNightMinutes(r.end);
        return {
          from: fromT,
          to: toT,
          fromLabel: label12(fromT),
          toLabel: label12(toT),
          type: r.type,
          note: r.type === "private_party" ? "Private party (venue closed for buyout)" : "Blocked by venue"
        };
      })
    };
  });

  const { TIME_SLOTS } = require("../../../../utils/time.utils");
  const startTimes: string[] = (TIME_SLOTS as string[]).map(label12);

  const pricing = settings
    ? {
        perGuestPrice: settings.perGuestPrice,
        maxGuestCapacity: settings.maxGuestCapacity,
        minDepositAmount: settings.minDepositAmount,
        extraHourPrice: settings.extraHourPrice,
        djPrice: settings.djPrice,
        photographerBasePrice: settings.photographerBasePrice,
        photographerExtraHourPrice: settings.photographerExtraHourPrice
      }
    : null;

  const lines = days.map(
    (d) => `${d.dateLabel}: ${d.blocked.map((r) => `${r.fromLabel}–${r.toLabel} (${r.type === "private_party" ? "private party" : "blocked"})`).join(", ")}`
  );
  const aiAvailabilitySummary = [
    `${VENUE_NAME} availability, updated ${new Date().toLocaleString("en-US", { timeZone: VENUE_TIMEZONE })} (New York time), covering ${dateLabel(startDate)} to ${dateLabel(toDateOnly(to))}.`,
    lines.length ? `UNAVAILABLE — do not offer these times: ${lines.join("; ")}.` : "No dates or times are blocked in this period.",
    `Every other date and time in this period is open for booking. Bookable start times: ${startTimes.join(", ")}.`,
    pricing
      ? `Private venue pricing: $${pricing.perGuestPrice} per guest (up to ${pricing.maxGuestCapacity} guests), minimum deposit $${pricing.minDepositAmount}, extra hour $${pricing.extraHourPrice}, DJ $${pricing.djPrice}, photographer $${pricing.photographerBasePrice} for 2 hours then $${pricing.photographerExtraHourPrice}/hour.`
      : ""
  ]
    .filter(Boolean)
    .join(" ");

  return {
    windowStart: startDate,
    windowEnd: toDateOnly(to),
    timezone: VENUE_TIMEZONE,
    blockedDays: days,
    blockedDatesCount: days.length,
    bookableStartTimes: TIME_SLOTS,
    pricing,
    aiAvailabilitySummary
  };
};

/**
 * Venue availability (blocked dates/times) for the next 90 days.
 * Event: "availability_updated" · Webhook: bookingSync
 */
export const sendGHLAvailabilityEvent = async (reason = "changed"): Promise<void> => {
  await safeTrigger("availability_updated", async () => ({
    webhook: "bookingSync",
    event: "availability_updated",
    ref: reason,
    payload: {
      event: "availability_updated",
      reason,
      ...(await buildAvailabilitySnapshot()),
      timestamp: new Date().toISOString()
    }
  }));
};

let timer: NodeJS.Timeout | null = null;
let pendingReason = "changed";

/** Debounced push — call freely from model hooks; a burst of changes sends one webhook. */
export const scheduleAvailabilitySync = (reason = "changed"): void => {
  pendingReason = reason;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    sendGHLAvailabilityEvent(pendingReason).catch((err) =>
      logger.error("[GHL] availability_updated failed", { error: err?.message })
    );
  }, DEBOUNCE_MS);
  timer.unref?.();
};

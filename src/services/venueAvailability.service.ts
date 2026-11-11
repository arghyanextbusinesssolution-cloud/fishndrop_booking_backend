import Booking from "../models/Booking";
import Event from "../models/Event";
import SlotLock from "../models/SlotLock";
import { timeToMinutes } from "../utils/time.utils";
import { addDays, getExternalBusyRanges, nyToUtc } from "./googleCalendar.service";

/**
 * ONE source of truth for "is the Tropica venue busy?" — used by the private venue booking
 * calendar, the promoter event-creation calendar and the server-side checks behind both.
 *
 * Times are minutes relative to 00:00 New York time of a "session date". A session runs
 * 08:00 → 08:00 next day, matching the booking model where times before 08:00 belong to the
 * previous evening (e.g. "01:00" on session 5 Dec = 1:00 AM on 6 Dec = minute 1500).
 */

export type BusySource = "private_event" | "table" | "admin_lock" | "promoter_event" | "google";

export interface BusyBlock {
  start: number;
  end: number;
  source: BusySource;
  label: string;
}

export const SESSION_START_MIN = 8 * 60;
export const SESSION_END_MIN = 32 * 60; // 08:00 next day

/** Promoter events in these states hold the venue (pending ones tentatively, until an admin decides). */
export const VENUE_HOLDING_EVENT_STATUSES = ["pending_approval", "published"];

const STANDARD_BOOKING_MINS = 120;
const SLOT_LOCK_MINS = 120;

export interface BusyOptions {
  excludeBookingId?: string;
  excludeEventId?: string;
}

const LABELS: Record<BusySource, string> = {
  private_event: "Private venue booking",
  table: "Table reservations",
  admin_lock: "Blocked by venue",
  promoter_event: "Another venue event",
  google: "Venue calendar booking"
};

/** Duration of an event given "HH:MM" start/end (end at or before start = next day). */
export const eventDurationMins = (startTime: string, endTime: string): number => {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let d = eh * 60 + em - (sh * 60 + sm);
  if (d <= 0) d += 1440;
  return d;
};

/** All busy blocks for one session date ("YYYY-MM-DD"), in session minutes. */
export const getSessionBusyBlocks = async (date: string, opts: BusyOptions = {}): Promise<BusyBlock[]> => {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const nextDayStart = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  const [bookings, locks, events, googleBusy] = await Promise.all([
    Booking.find({
      bookingDate: { $gte: dayStart, $lt: nextDayStart },
      status: { $in: ["confirmed", "pending"] }
    }).select("bookingType bookingTime durationHours"),
    SlotLock.find({ bookingDate: { $gte: dayStart, $lt: nextDayStart }, isLocked: true }).select("bookingTime eventId"),
    // Events on this date (evening starts) and on the next date (after-midnight starts)
    Event.find({
      venueType: "tropica",
      status: { $in: VENUE_HOLDING_EVENT_STATUSES },
      date: { $gte: dayStart, $lte: nextDayStart }
    }).select("date startTime endTime"),
    getExternalBusyRanges(nyToUtc(date, 8, 0), nyToUtc(addDays(date, 1), 8, 0))
  ]);

  const blocks: BusyBlock[] = [];
  const push = (start: number, end: number, source: BusySource) => {
    const s = Math.max(start, SESSION_START_MIN);
    const e = Math.min(end, SESSION_END_MIN);
    if (e > s) blocks.push({ start: s, end: e, source, label: LABELS[source] });
  };

  for (const b of bookings) {
    if (opts.excludeBookingId && b._id.toString() === opts.excludeBookingId) continue;
    if (!b.bookingTime) continue;
    const start = timeToMinutes(b.bookingTime);
    if (b.bookingType === "private_event") push(start, start + (b.durationHours || 1) * 60, "private_event");
    else push(start, start + STANDARD_BOOKING_MINS, "table");
  }

  for (const l of locks) {
    if (opts.excludeBookingId && l.eventId?.toString() === opts.excludeBookingId) continue;
    // Locks created for a private buyout duplicate that booking's own block; keep only admin locks
    if (l.eventId) continue;
    const start = timeToMinutes(l.bookingTime);
    push(start, start + SLOT_LOCK_MINS, "admin_lock");
  }

  for (const ev of events) {
    if (opts.excludeEventId && ev._id.toString() === opts.excludeEventId) continue;
    const sameDay = new Date(ev.date).getTime() === dayStart.getTime();
    const startHour = Number(ev.startTime.split(":")[0]);
    if (sameDay ? startHour < 8 : startHour >= 8) continue; // belongs to another session
    const start = timeToMinutes(ev.startTime);
    push(start, start + eventDurationMins(ev.startTime, ev.endTime), "promoter_event");
  }

  const sessionMidnight = nyToUtc(date, 0, 0).getTime();
  for (const r of googleBusy) {
    push((r.start.getTime() - sessionMidnight) / 60000, (r.end.getTime() - sessionMidnight) / 60000, "google");
  }

  return blocks.sort((a, b) => a.start - b.start);
};

export const overlapsAny = (blocks: BusyBlock[], start: number, end: number): BusyBlock | undefined =>
  blocks.find((b) => start < b.end && b.start < end);

/** Merge overlapping/adjacent blocks for display. */
export const mergeBlocks = (blocks: BusyBlock[]): BusyBlock[] => {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out: BusyBlock[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
      if (last.label !== b.label) last.label = "Venue booked";
    } else out.push({ ...b });
  }
  return out;
};

/**
 * Busy blocks for a CALENDAR day as a promoter sees it: minutes from 00:00 on `date`, covering
 * 00:00 that day → 08:00 the next day (so an event that runs past midnight can be checked).
 * Combines the tail of the previous session (00:00–08:00) with this date's session.
 */
export const getCalendarDayBusyBlocks = async (date: string, opts: BusyOptions = {}): Promise<BusyBlock[]> => {
  const [prev, current] = await Promise.all([
    getSessionBusyBlocks(addDays(date, -1), opts),
    getSessionBusyBlocks(date, opts)
  ]);
  const shifted = prev
    .map((b) => ({ ...b, start: b.start - 1440, end: b.end - 1440 }))
    .filter((b) => b.end > 0)
    .map((b) => ({ ...b, start: Math.max(0, b.start) }));
  return [...shifted, ...current].sort((a, b) => a.start - b.start);
};

/**
 * Checks a promoter event slot at Tropica. `startTime`/`endTime` are "HH:MM" on `date`
 * (end at or before start = next day). Returns the conflicting block, if any.
 */
export const findEventConflict = async (
  date: string,
  startTime: string,
  endTime: string,
  opts: BusyOptions = {}
): Promise<BusyBlock | undefined> => {
  const [sh, sm] = startTime.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = start + eventDurationMins(startTime, endTime);
  const blocks = await getCalendarDayBusyBlocks(date, opts);
  return overlapsAny(blocks, start, end);
};

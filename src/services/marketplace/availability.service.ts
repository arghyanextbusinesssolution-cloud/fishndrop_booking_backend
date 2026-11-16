import { Types } from "mongoose";
import PartnerVenue, { IPartnerVenue, resolveWeeklyHours } from "../../models/PartnerVenue";
import VenueBlock from "../../models/VenueBlock";
import { timeToMinutes } from "../../utils/time.utils";

/**
 * Partner-venue availability. Times are minutes from 00:00 New York time on the session `date`
 * (YYYY-MM-DD); a closeTime at/before openTime means the venue closes after midnight.
 */

export interface VenueSlot {
  startTime: string; // "HH:MM" (may be a next-day time when endMin > 1440)
  endTime: string;
  startMin: number;
  endMin: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const minutesToHHMM = (min: number): string => `${pad(Math.floor((min % 1440) / 60))}:${pad(min % 60)}`;

export const nyTodayAndNow = (): { today: string; nowMin: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  return { today: `${get("year")}-${get("month")}-${get("day")}`, nowMin: Number(get("hour")) * 60 + Number(get("minute")) };
};

export const isValidSessionDate = (date: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00Z`).getTime());

const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

const toWindow = (openTime: string, closeTime: string) => {
  const open = timeToMinutes(openTime);
  let close = timeToMinutes(closeTime);
  if (close <= open) close += 1440; // closes after midnight
  return { open, close };
};

/** Opening window (minutes) for the venue on a given session date, or null when closed that weekday. */
export const operatingWindowOn = (
  venue: Pick<IPartnerVenue, "weeklyHours" | "openTime" | "closeTime" | "operatingDays">,
  date: string
): { open: number; close: number } | null => {
  const day = resolveWeeklyHours(venue).find((d) => d.day === weekdayOf(date));
  return day?.open ? toWindow(day.openTime, day.closeTime) : null;
};

/** Legacy single window — kept for callers without a date. */
export const operatingWindow = (venue: Pick<IPartnerVenue, "openTime" | "closeTime">): { open: number; close: number } =>
  toWindow(venue.openTime, venue.closeTime);

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** Start times on `date` where the venue is free for `durationHours`. */
export const availableSlots = async (
  venue: IPartnerVenue,
  date: string,
  durationHours: number
): Promise<VenueSlot[]> => {
  if (!isValidSessionDate(date)) return [];
  const { today, nowMin } = nyTodayAndNow();
  if (date < today) return [];
  const window = operatingWindowOn(venue, date);
  if (!window) return []; // closed that weekday

  const hours = Math.max(venue.minHours || 1, durationHours || 0);
  const durationMins = Math.round(hours * 60);
  const { open, close } = window;
  const step = venue.slotStepMins || 60;
  // Late-night blocks from the previous session can spill into this one.
  const blocks = await VenueBlock.find({ venue: venue._id, date }).lean();

  const slots: VenueSlot[] = [];
  for (let start = open; start + durationMins <= close; start += step) {
    const end = start + durationMins;
    if (date === today && start <= nowMin + 60) continue; // need at least an hour's notice
    if (blocks.some((b) => overlaps(start, end, b.startMin, b.endMin))) continue;
    slots.push({ startTime: minutesToHHMM(start), endTime: minutesToHHMM(end), startMin: start, endMin: end });
  }
  return slots;
};

/** True when the exact range is still free (re-checked at request + payment time). */
export const isRangeFree = async (venueId: Types.ObjectId | string, date: string, startMin: number, endMin: number, ignoreBookingId?: string) => {
  const clash = await VenueBlock.findOne({
    venue: venueId,
    date,
    startMin: { $lt: endMin },
    endMin: { $gt: startMin },
    ...(ignoreBookingId ? { booking: { $ne: ignoreBookingId } } : {})
  }).lean();
  return !clash;
};

/** Published venues that fit the party and have at least one free minimum-length slot that day. */
export const availableVenuesOn = async (date: string, guests?: number) => {
  const query: Record<string, unknown> = { status: "published" };
  if (guests && guests > 0) query.maxGuests = { $gte: guests };
  const venues = await PartnerVenue.find(query).sort({ name: 1 });
  const results = await Promise.all(
    venues.map(async (venue) => {
      const slots = await availableSlots(venue, date, venue.minHours || 1);
      return { venue, available: slots.length > 0, slotCount: slots.length };
    })
  );
  return results;
};

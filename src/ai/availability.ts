import { getPrivateEventAvailability, getStandardAvailability } from "../services/booking";
import { addDaysYmd, endTime, isValidYmd, normalizeTime, nyNowMinutes, nyToday, prettyDate, to12h } from "./dates";
import {
  getPricing,
  MAX_DURATION,
  MIN_DURATION,
  MIN_VENUE_GUESTS,
  INCLUDED_HOURS,
  Pricing,
  siteLinks
} from "./knowledge";

/**
 * Live availability for the AI — always read from the same booking engine the website uses
 * (private buyouts, table bookings, admin slot blocks, promoter events, Google Calendar entries).
 * The AI never decides availability itself; it only repeats what these functions return.
 */

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export interface Quote {
  guests: number;
  durationHours: number;
  base: number;
  extraHours: number;
  extraHoursCost: number;
  dj: number;
  photographer: number;
  total: number;
  deposit: number;
  balance: number;
  text: string;
}

export const priceQuote = (
  p: Pricing,
  guests: number,
  durationHours = INCLUDED_HOURS,
  dj = false,
  photographer = false,
  photographerHours = 2
): Quote => {
  const base = guests * p.perGuestPrice;
  const extraHours = Math.max(0, durationHours - INCLUDED_HOURS);
  const extraHoursCost = extraHours * p.extraHourPrice;
  const djCost = dj ? p.djPrice : 0;
  const photoCost = photographer
    ? p.photographerBasePrice + Math.max(0, photographerHours - 2) * p.photographerExtraHourPrice
    : 0;
  const total = base + extraHoursCost + djCost + photoCost;
  const deposit = Math.min(total, p.minDepositAmount);
  const parts = [`${guests} guests × $${p.perGuestPrice} = $${base}`];
  if (extraHours) parts.push(`${extraHours} extra hour(s) = $${extraHoursCost}`);
  if (djCost) parts.push(`DJ $${djCost}`);
  if (photoCost) parts.push(`photographer (${photographerHours}h) $${photoCost}`);
  return {
    guests,
    durationHours,
    base,
    extraHours,
    extraHoursCost,
    dj: djCost,
    photographer: photoCost,
    total,
    deposit,
    balance: total - deposit,
    text: `${parts.join(" + ")} → total $${total}. Deposit $${deposit} to secure the date, balance $${total - deposit} due 72h before the event. Catering not included.`
  };
};

/** Open private start times for one date (already filtered for "too soon" when the date is today). */
const openVenueStarts = async (date: string, durationHours: number): Promise<string[]> => {
  const { slots } = await getPrivateEventAvailability(date, durationHours);
  const today = nyToday();
  const cutoff = date === today ? nyNowMinutes() + 60 : -1;
  return slots.filter((s) => s.isAvailable && minutesOf(s.slot) > cutoff).map((s) => s.slot);
};

const durationOf = (raw: unknown): { hours: number; error?: string } => {
  const n = raw === undefined || raw === null || raw === "" ? INCLUDED_HOURS : Math.round(Number(raw));
  if (!Number.isFinite(n)) return { hours: INCLUDED_HOURS };
  if (n < MIN_DURATION) return { hours: MIN_DURATION, error: `Minimum booking is ${MIN_DURATION} hours (that's included in the price).` };
  if (n > MAX_DURATION) return { hours: MAX_DURATION, error: `Maximum booking is ${MAX_DURATION} hours.` };
  return { hours: n };
};

const dateProblem = (date: unknown): string | null => {
  if (!isValidYmd(date)) return "Invalid date — use YYYY-MM-DD.";
  if (date < nyToday()) return "That date is in the past.";
  if (date > addDaysYmd(nyToday(), 365)) return "Bookings open up to 12 months ahead.";
  return null;
};

export const checkVenueAvailability = async (args: {
  date?: string;
  start_time?: string;
  duration_hours?: number;
  guests?: number;
}) => {
  const problem = dateProblem(args.date);
  if (problem) return { ok: false, error: problem };
  const date = args.date as string;

  const dur = durationOf(args.duration_hours);
  const pricing = await getPricing();
  const guests = args.guests ? Math.round(Number(args.guests)) : undefined;
  const guestNote =
    guests && guests < MIN_VENUE_GUESTS
      ? `Private venue buyouts need at least ${MIN_VENUE_GUESTS} guests — a table reservation fits ${guests} guests better.`
      : guests && guests > pricing.maxGuestCapacity
        ? `Maximum capacity is ${pricing.maxGuestCapacity} guests.`
        : undefined;

  const open = await openVenueStarts(date, dur.hours);
  const openLabels = open.map((t) => `${to12h(t)}–${to12h(endTime(t, dur.hours))}`);

  let start: string | null = null;
  let startProblem: string | undefined;
  if (args.start_time) {
    start = normalizeTime(args.start_time);
    if (!start) startProblem = "Could not read the start time.";
    else if (start.slice(3) !== "00" || minutesOf(start) < 10 * 60 || minutesOf(start) > 23 * 60)
      startProblem = "Private bookings start on the hour between 10 AM and 11 PM.";
  }

  const requestedAvailable = start && !startProblem ? open.includes(start) : undefined;
  const windowLabel = start ? `${to12h(start)}–${to12h(endTime(start, dur.hours))}` : undefined;

  let summary: string;
  if (start && !startProblem) {
    summary = requestedAvailable
      ? `${prettyDate(date)} ${windowLabel} (${dur.hours}h) is OPEN right now for a private buyout.`
      : `${prettyDate(date)} ${windowLabel} (${dur.hours}h) is NOT available.` +
        (open.length ? ` Open ${dur.hours}h start times that day: ${open.map(to12h).join(", ")}.` : " Nothing else is open for that length that day.");
  } else {
    summary = open.length
      ? `${prettyDate(date)} open ${dur.hours}h start times: ${open.map(to12h).join(", ")}.`
      : `${prettyDate(date)} has no open ${dur.hours}h private window.`;
  }

  return {
    ok: true,
    date,
    dateLabel: prettyDate(date),
    durationHours: dur.hours,
    durationNote: dur.error,
    requestedStart: start ? to12h(start) : undefined,
    requestedWindow: windowLabel,
    startTimeProblem: startProblem,
    requestedAvailable,
    openStartTimes: open.map(to12h),
    openWindows: openLabels,
    guests,
    guestNote,
    quote: guests && !guestNote ? priceQuote(pricing, guests, dur.hours).text : undefined,
    summary,
    note: "Availability is live right now but not held — it is only secured once booked and the deposit is paid on the website."
  };
};

export const findOpenVenueDates = async (args: {
  from_date?: string;
  days?: number;
  duration_hours?: number;
  start_time?: string;
  weekdays_only?: string[];
}) => {
  const from = args.from_date && isValidYmd(args.from_date) && args.from_date >= nyToday() ? args.from_date : nyToday();
  const days = Math.min(21, Math.max(1, Math.round(Number(args.days) || 7)));
  const dur = durationOf(args.duration_hours);
  const wanted = args.start_time ? normalizeTime(args.start_time) : null;
  const filterDays = (args.weekdays_only || []).map((d) => String(d).slice(0, 3).toLowerCase());

  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(from, i);
    const wd = new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" }).toLowerCase();
    if (!filterDays.length || filterDays.includes(wd)) dates.push(ymd);
  }

  const results: { date: string; label: string; openStartTimes: string[]; requestedStartOpen?: boolean }[] = [];
  for (let i = 0; i < dates.length; i += 7) {
    const batch = await Promise.all(dates.slice(i, i + 7).map(async (d) => ({ d, open: await openVenueStarts(d, dur.hours) })));
    for (const { d, open } of batch) {
      results.push({
        date: d,
        label: prettyDate(d),
        openStartTimes: open.map(to12h),
        requestedStartOpen: wanted ? open.includes(wanted) : undefined
      });
    }
  }

  const matching = wanted ? results.filter((r) => r.requestedStartOpen) : results.filter((r) => r.openStartTimes.length);
  return {
    ok: true,
    durationHours: dur.hours,
    searched: `${prettyDate(from)} → ${prettyDate(addDaysYmd(from, days - 1))}`,
    requestedStart: wanted ? to12h(wanted) : undefined,
    datesWithOpenings: matching.slice(0, 8).map((r) =>
      wanted ? `${r.label} at ${to12h(wanted)}` : `${r.label}: ${r.openStartTimes.slice(0, 6).join(", ")}${r.openStartTimes.length > 6 ? "…" : ""}`
    ),
    fullyBookedDates: results.filter((r) => !r.openStartTimes.length).map((r) => r.label)
  };
};

export const checkTableAvailability = async (args: { date?: string; guests?: number; time?: string }) => {
  const problem = dateProblem(args.date);
  if (problem) return { ok: false, error: problem };
  const date = args.date as string;
  const guests = Math.max(1, Math.round(Number(args.guests) || 2));
  const { slots } = await getStandardAvailability(date, guests, false);
  const today = nyToday();
  const cutoff = date === today ? nyNowMinutes() + 30 : -1;
  const isFuture = (t: string) => {
    const m = minutesOf(t);
    return (m < 8 * 60 ? m + 1440 : m) > cutoff; // after-midnight slots belong to the same night
  };
  const open = slots.filter((s: any) => s.isAvailable && isFuture(s.slot)).map((s: any) => to12h(s.slot));
  const wanted = args.time ? normalizeTime(args.time) : null;
  return {
    ok: true,
    date,
    dateLabel: prettyDate(date),
    guests,
    requestedTime: wanted ? to12h(wanted) : undefined,
    requestedAvailable: wanted ? open.includes(to12h(wanted)) : undefined,
    openTimes: open,
    summary: open.length
      ? `Tables for ${guests} on ${prettyDate(date)} open at: ${open.join(", ")}.`
      : `No table times open for ${guests} on ${prettyDate(date)}.`
  };
};

export const buildBookingLink = (args: {
  type?: string;
  date?: string;
  start_time?: string;
  guests?: number;
  duration_hours?: number;
  channel?: string;
}) => {
  const links = siteLinks();
  const type = args.type === "table" ? "table" : args.type === "tour" ? "tour" : args.type === "events" ? "events" : "venue";
  // Short, clean link for a DM: only what the pages actually read (+ tracking so DM revenue shows up)
  const url = new URL(links[type]);
  if (type === "table" && args.date && isValidYmd(args.date)) url.searchParams.set("date", args.date);
  const source = /facebook|fb|messenger/i.test(args.channel || "") ? "facebook" : "instagram";
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", "ai_dm");
  const t = args.start_time ? normalizeTime(args.start_time) : null;
  return {
    ok: true,
    type,
    url: url.toString(),
    // what the customer should pick on the page — put this in the message
    pickOnPage: [args.date && isValidYmd(args.date) ? prettyDate(args.date) : "", t ? to12h(t) : "", args.guests ? `${args.guests} guests` : "", type === "venue" && args.duration_hours ? `${args.duration_hours} hours` : ""]
      .filter(Boolean)
      .join(", ")
  };
};

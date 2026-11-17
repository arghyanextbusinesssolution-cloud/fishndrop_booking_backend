import logger from "../config/logger";
import AiConversation from "../models/AiConversation";
import { getSessionBusyBlocks, overlapsAny } from "../services/venueAvailability.service";
import { nyToUtc } from "../services/googleCalendar.service";
import { dispatchToGHL } from "../integrations/ghl/client";
import { addDaysYmd, isValidYmd, normalizeTime, nyNowMinutes, nyToday, prettyDate, to12h } from "./dates";

/**
 * Walkthrough (venue tour) booked inside the DM.
 *
 *   check_walkthrough → open times = free slots in GHL "Tropica's Walk Through Calendar"
 *                       MINUS anything on the booking side: Tropica parties/events/blocks (venue schedule)
 *                       and appointments on the GHL "Tropica Event space booking" calendar.
 *   book_walkthrough  → creates the appointment in the GHL walkthrough calendar (or moves the chat's existing one),
 *                       then sends event "walkthrough_booking" (name, phone, date, time, appointmentId) to GHL.
 *
 * .env:
 *   GHL_CALENDAR_TOKEN            key with calendars + calendar events read/write (falls back to GHL_API_TOKEN)
 *   GHL_LOCATION_ID               GHL sub-account (location) id
 *   GHL_WALKTHROUGH_CALENDAR_ID   "Tropica's Walk Through Calendar"
 *   GHL_EVENT_SPACE_CALENDAR_ID   "Tropica Event space booking" (optional)
 *   AI_WALKTHROUGH_HOURS / AI_WALKTHROUGH_MINUTES   only used if the GHL calendar can't be read
 */

const API = "https://services.leadconnectorhq.com";
const VENUE_ADDRESS = "1007 Hegeman Avenue, Brooklyn, NY 11208";

const cfg = () => ({
  token: process.env.GHL_CALENDAR_TOKEN?.trim() || process.env.GHL_API_TOKEN?.trim() || "",
  locationId: process.env.GHL_LOCATION_ID?.trim() || "",
  walkthroughCalendarId: process.env.GHL_WALKTHROUGH_CALENDAR_ID?.trim() || "",
  eventSpaceCalendarId: process.env.GHL_EVENT_SPACE_CALENDAR_ID?.trim() || ""
});

const ghl = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg().token}`,
      Version: "2021-04-15",
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { ok: res.ok, status: res.status, json, text };
};

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

const fallbackSettings = () => {
  const [from, to] = (process.env.AI_WALKTHROUGH_HOURS || "10:00-21:00").split("-").map((s) => normalizeTime(s.trim()) || "");
  return {
    firstStart: minutesOf(from || "10:00"),
    lastStart: minutesOf(to || "21:00"),
    length: Math.min(180, Math.max(15, Number(process.env.AI_WALKTHROUGH_MINUTES) || 30))
  };
};

const dayRangeMs = (date: string) => ({ start: nyToUtc(date, 0, 0).getTime(), end: nyToUtc(addDaysYmd(date, 1), 0, 0).getTime() - 1 });

/** Free start times ("HH:MM") in the GHL walkthrough calendar, or null when it can't be read. */
const walkthroughCalendarSlots = async (date: string): Promise<string[] | null> => {
  const c = cfg();
  if (!c.walkthroughCalendarId || !c.token) return null;
  try {
    const { start, end } = dayRangeMs(date);
    const r = await ghl("GET", `/calendars/${c.walkthroughCalendarId}/free-slots?startDate=${start}&endDate=${end}&timezone=America/New_York`);
    if (!r.ok) {
      logger.warn("[AI] walkthrough calendar not readable — using venue hours", { status: r.status, body: r.text.slice(0, 200) });
      return null;
    }
    // "2026-11-25T15:00:00-05:00" → "15:00"
    return ((r.json?.[date]?.slots || []) as string[]).map((s) => String(s).slice(11, 16));
  } catch (err: any) {
    logger.warn("[AI] walkthrough free-slots failed", { error: err?.message });
    return null;
  }
};

/** Busy ranges (session minutes) from appointments on the GHL "Tropica Event space booking" calendar. */
const eventSpaceBusy = async (date: string): Promise<{ start: number; end: number }[]> => {
  const c = cfg();
  if (!c.eventSpaceCalendarId || !c.locationId || !c.token) return [];
  try {
    const { start, end } = dayRangeMs(date);
    const r = await ghl("GET", `/calendars/events?locationId=${c.locationId}&calendarId=${c.eventSpaceCalendarId}&startTime=${start}&endTime=${end}`);
    if (!r.ok) return [];
    const midnight = nyToUtc(date, 0, 0).getTime();
    return ((r.json?.events || []) as any[])
      .filter((e) => !["cancelled", "invalid"].includes(String(e.appointmentStatus || "").toLowerCase()))
      .map((e) => ({ start: (new Date(e.startTime).getTime() - midnight) / 60000, end: (new Date(e.endTime).getTime() - midnight) / 60000 }));
  } catch {
    return [];
  }
};

/** Open walkthrough starts for a date + slot length + whether the real calendar was used. */
const openStarts = async (date: string) => {
  const fb = fallbackSettings();
  const [calendarSlots, venueBlocks, spaceBusy] = await Promise.all([walkthroughCalendarSlots(date), getSessionBusyBlocks(date), eventSpaceBusy(date)]);
  const length = fb.length; // walkthrough calendar slots are 30 min
  const candidates = calendarSlots ?? (() => {
    const out: string[] = [];
    for (let m = fb.firstStart; m <= fb.lastStart; m += 30) out.push(hhmm(m));
    return out;
  })();
  const cutoff = date === nyToday() ? nyNowMinutes() + 60 : -1;
  const open = candidates.filter((t) => {
    const m = minutesOf(t);
    if (m <= cutoff) return false;
    if (overlapsAny(venueBlocks, m, m + length)) return false; // party / promoter event / admin block at the venue
    if (spaceBusy.some((b) => m < b.end && b.start < m + length)) return false; // event-space booking in GHL
    return true;
  });
  return { open, length, calendarChecked: calendarSlots !== null };
};

export interface WalkthroughArgs {
  date?: string;
  time?: string;
}

/** check_walkthrough — is that walkthrough date/time free? Lists the open times when it isn't (or when no time given). */
export const checkWalkthrough = async (a: WalkthroughArgs) => {
  if (!isValidYmd(a.date)) return { ok: false, error: "Ask for the walkthrough date (month and day)." };
  const date = a.date as string;
  if (date < nyToday()) return { ok: false, error: "That date is in the past." };
  if (date > addDaysYmd(nyToday(), 90)) return { ok: false, error: "Walkthroughs can be booked up to 90 days ahead." };

  const time = a.time ? normalizeTime(a.time) : null;
  const { open, length, calendarChecked } = await openStarts(date);
  const label = prettyDate(date);

  if (!time) {
    return {
      ok: true,
      date,
      dateLabel: label,
      available: open.length > 0,
      freeTimes: open.slice(0, 8).map(to12h),
      calendarChecked,
      summary: open.length ? `${label}: walkthrough times open ${open.slice(0, 6).map(to12h).join(", ")}${open.length > 6 ? "…" : ""}.` : `${label}: no walkthrough times open — try another day.`,
      note: "Ask which time they'd like."
    };
  }

  const available = open.includes(time);
  const mins = minutesOf(time);
  const nearest = [...open].sort((x, y) => Math.abs(minutesOf(x) - mins) - Math.abs(minutesOf(y) - mins)).slice(0, 4).sort();
  return {
    ok: true,
    date,
    dateLabel: label,
    time,
    timeLabel: to12h(time),
    available,
    walkthroughMinutes: length,
    otherTimesThatDay: available ? undefined : nearest.map(to12h),
    calendarChecked,
    summary: available
      ? `${label} at ${to12h(time)} is open for a walkthrough.`
      : `${label} at ${to12h(time)} is NOT available for a walkthrough.${nearest.length ? ` Open that day: ${nearest.map(to12h).join(", ")}.` : " Nothing else open that day — try another day."}`
  };
};

const normalizePhone = (raw?: string): string | null => {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (hasPlus && d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
};

/**
 * book_walkthrough — re-checks the slot, creates the appointment in the GHL walkthrough calendar
 * (or moves this chat's existing one), then notifies GHL with event "walkthrough_booking".
 */
export const bookWalkthrough = async (
  a: WalkthroughArgs & { full_name?: string; phone?: string; email?: string; notes?: string; contactId: string; channel: string }
) => {
  const name = (a.full_name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const phone = normalizePhone(a.phone);
  const missing = [!name ? "full name" : "", !phone ? "mobile phone number" : "", !isValidYmd(a.date) ? "date" : "", !normalizeTime(a.time) ? "time" : ""].filter(Boolean);
  if (missing.length) return { ok: false, missing, error: `Missing: ${missing.join(", ")}` };

  const check: any = await checkWalkthrough({ date: a.date, time: a.time });
  if (!check.ok) return check;
  if (!check.available) return { ok: false, available: false, error: check.summary, otherTimesThatDay: check.otherTimesThatDay };

  const date = check.date as string;
  const time = check.time as string;
  const [h, m] = time.split(":").map(Number);
  const start = nyToUtc(date, h, m);
  const end = new Date(start.getTime() + check.walkthroughMinutes * 60 * 1000);
  const [firstName, ...rest] = name.split(" ");
  const c = cfg();

  // ---- create (or move) the appointment in the GHL walkthrough calendar
  let appointmentId: string | undefined;
  let createdInCalendar = false;
  if (c.walkthroughCalendarId && c.locationId && c.token) {
    const conv: any = await AiConversation.findOne({ contactId: a.contactId }).select("walkthrough").lean();
    const existingId: string | undefined = conv?.walkthrough?.appointmentId;
    const body = {
      calendarId: c.walkthroughCalendarId,
      locationId: c.locationId,
      contactId: a.contactId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      title: `Walkthrough – ${name}`,
      appointmentStatus: "confirmed",
      address: VENUE_ADDRESS,
      toNotify: true
    };
    const r = existingId
      ? await ghl("PUT", `/calendars/events/appointments/${existingId}`, body)
      : await ghl("POST", `/calendars/events/appointments`, body);
    if (!r.ok) {
      logger.error("[AI] walkthrough appointment failed", { contactId: a.contactId, status: r.status, body: r.text.slice(0, 300) });
      return { ok: false, error: "Couldn't create the walkthrough in the calendar right now — share the walkthrough calendar link instead." };
    }
    appointmentId = r.json?.id || r.json?.appointment?.id || existingId;
    createdInCalendar = true;
    console.log(`[AI] 🗓️  Walkthrough ${existingId ? "moved" : "created"} in GHL calendar → ${appointmentId} (${date} ${time})`);
  }

  // ---- notify GHL (event "walkthrough_booking") — also the fallback when the calendar isn't configured
  const payload = {
    event: "walkthrough_booking",
    source: "tropica_ai_assistant",
    sentAt: new Date().toISOString(),
    contactId: a.contactId,
    contact_id: a.contactId,
    channel: a.channel,
    name,
    firstName,
    lastName: rest.join(" "),
    phone,
    email: (a.email || "").trim().toLowerCase(),
    walkthroughDate: date,
    walkthroughDateFormatted: check.dateLabel,
    walkthroughTime: to12h(time),
    walkthroughTime24: time,
    walkthroughStart: start.toISOString(),
    walkthroughEnd: end.toISOString(),
    walkthroughMinutes: check.walkthroughMinutes,
    timezone: "America/New_York",
    appointmentId: appointmentId || "",
    appointmentCreated: createdInCalendar ? "yes" : "no",
    notes: (a.notes || "").slice(0, 500),
    summary: `Walkthrough for ${name} (${phone}) on ${check.dateLabel} at ${to12h(time)} (${check.walkthroughMinutes} min)`
  };
  const sent = await dispatchToGHL({ webhook: "aiWalkthrough", event: "walkthrough_booking", ref: a.contactId.slice(0, 8), payload }).catch(() => undefined);
  if (!createdInCalendar && !sent?.ok) {
    logger.error("[AI] walkthrough webhook failed", { contactId: a.contactId, status: sent?.status });
    return { ok: false, error: "Couldn't book the walkthrough right now — share the walkthrough calendar link instead." };
  }

  await AiConversation.updateOne(
    { contactId: a.contactId },
    { $set: { walkthrough: { date, time, requestedAt: new Date(), status: createdInCalendar ? "booked" : "requested", appointmentId }, contactName: name, contactPhone: phone } }
  );
  logger.info("[AI] walkthrough booked", { contactId: a.contactId, date, time, appointmentId, createdInCalendar });
  return {
    ok: true,
    booked: createdInCalendar,
    dateLabel: check.dateLabel,
    timeLabel: to12h(time),
    note: createdInCalendar
      ? `BOOKED in the walkthrough calendar. Tell them: "You're all set! Your walkthrough is on ${check.dateLabel} at ${to12h(time)} at ${VENUE_ADDRESS}." This does NOT reserve the venue for an event.`
      : `Sent to the team. Tell them their walkthrough on ${check.dateLabel} at ${to12h(time)} is requested and they'll get a confirmation shortly. This does NOT reserve the venue for an event.`
  };
};

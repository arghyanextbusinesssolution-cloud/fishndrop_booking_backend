import jwt from "jsonwebtoken";
import logger from "../config/logger";

/**
 * Minimal Google Calendar REST client authenticated as a service account.
 * The calendar (GOOGLE_CALENDAR_ID) must be shared with the service account's client_email
 * with "Make changes to events".
 */

export const VENUE_TZ = "America/New_York";
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";
/** Marks events this site created, so the two-way read never treats our own entries as outside blocks. */
export const SYNC_SOURCE = "fishndrop";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedAccount: ServiceAccount | null | undefined;
let cachedToken: { token: string; expiresAt: number } | null = null;
let warnedDisabled = false;

const loadServiceAccount = (): ServiceAccount | null => {
  if (cachedAccount !== undefined) return cachedAccount;
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_B64
      ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
      : process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
    if (!raw) return (cachedAccount = null);
    const parsed = JSON.parse(raw);
    cachedAccount = parsed.client_email && parsed.private_key ? parsed : null;
  } catch (err: any) {
    logger.error("[Google Calendar] Could not parse service account credentials", { error: err.message });
    cachedAccount = null;
  }
  return cachedAccount ?? null;
};

const calendarId = () => (process.env.GOOGLE_CALENDAR_ID || "").trim();

export const isGoogleCalendarEnabled = (silent = false): boolean => {
  const hasAccount = !!loadServiceAccount();
  const hasCalendar = !!calendarId();
  const enabled = hasAccount && hasCalendar;
  if (silent) return enabled;
  if (!enabled) {
    // Logged on every attempt (not once) so a skipped sync is always visible in the console
    logger.warn(
      `[Google Calendar] ✗ Sync SKIPPED — ${!hasAccount ? "GOOGLE_SERVICE_ACCOUNT_B64 missing/invalid" : ""}${
        !hasAccount && !hasCalendar ? " and " : ""
      }${!hasCalendar ? "GOOGLE_CALENDAR_ID is empty in backend/.env" : ""}`
    );
  } else if (!warnedDisabled) {
    warnedDisabled = true;
    logger.info(`[Google Calendar] ✓ Enabled → calendar "${calendarId()}" as ${loadServiceAccount()!.client_email}`);
  }
  return enabled;
};

const getAccessToken = async (): Promise<string> => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const sa = loadServiceAccount();
  if (!sa) throw new Error("Google service account not configured");

  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: CAL_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: "RS256" }
  );

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token request failed (${res.status}): ${data.error_description || data.error || "unknown"}`);
  }
  logger.info("[Google Calendar]   step 1/3 ✓ access token obtained");
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
};

class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const gcal = async (method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<any> => {
  const token = await getAccessToken();
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await fetch(`${API}/calendars/${encodeURIComponent(calendarId())}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  if (res.status === 204) return null;
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleApiError(res.status, data?.error?.message || `Google Calendar ${method} failed (${res.status})`);
  return data;
};

export interface CalendarEventInput {
  /** Stable id (lowercase a-v / 0-9, 5–1024 chars) so retries update instead of duplicating. */
  id: string;
  summary: string;
  description: string;
  /** "YYYY-MM-DDTHH:MM:00" New York wall-clock. */
  startLocal: string;
  endLocal: string;
  tentative?: boolean;
  location?: string;
  kind: "booking" | "event";
  refId: string;
}

/** Create the event, or update it in place if it already exists (also revives a previously deleted one). */
export const upsertCalendarEvent = async (input: CalendarEventInput): Promise<void> => {
  const resource = {
    id: input.id,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: { dateTime: input.startLocal, timeZone: VENUE_TZ },
    end: { dateTime: input.endLocal, timeZone: VENUE_TZ },
    status: input.tentative ? "tentative" : "confirmed",
    transparency: "opaque",
    extendedProperties: { private: { source: SYNC_SOURCE, kind: input.kind, refId: input.refId } }
  };
  logger.info(
    `[Google Calendar]   step 2/3 → sending "${input.summary}" ${input.startLocal} → ${input.endLocal} (${VENUE_TZ}) to calendar "${calendarId()}"`
  );
  try {
    const updated = await gcal("PUT", `/events/${input.id}`, resource);
    logger.info(`[Google Calendar]   step 3/3 ✓ updated existing calendar entry ${input.id} ${updated?.htmlLink || ""}`);
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) {
      const created = await gcal("POST", "/events", resource);
      logger.info(`[Google Calendar]   step 3/3 ✓ created new calendar entry ${input.id} ${created?.htmlLink || ""}`);
      return;
    }
    if (err instanceof GoogleApiError && (err.status === 403 || err.status === 401)) {
      logger.error(
        `[Google Calendar]   step 3/3 ✗ permission denied — share calendar "${calendarId()}" with ${loadServiceAccount()?.client_email} ("Make changes to events")`
      );
    } else if (err instanceof GoogleApiError) {
      logger.error(`[Google Calendar]   step 3/3 ✗ Google returned ${err.status}: ${err.message}`);
    }
    throw err;
  }
};

export const deleteCalendarEvent = async (id: string): Promise<void> => {
  try {
    await gcal("DELETE", `/events/${id}`);
    logger.info(`[Google Calendar]   ✓ removed calendar entry ${id}`);
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return; // already gone
    throw err;
  }
};

/** Every calendar entry this website created (any status except deleted) between two instants. */
export const listSyncedCalendarEvents = async (
  timeMin: Date,
  timeMax: Date
): Promise<Array<{ id: string; kind: string; refId: string }>> => {
  const out: Array<{ id: string; kind: string; refId: string }> = [];
  let pageToken: string | undefined;
  do {
    const data = await gcal("GET", "/events", undefined, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      privateExtendedProperty: `source=${SYNC_SOURCE}`,
      singleEvents: "true",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {})
    });
    for (const ev of data?.items || []) {
      const p = ev.extendedProperties?.private;
      if (ev.status !== "cancelled" && p?.refId) out.push({ id: ev.id, kind: p.kind, refId: p.refId });
    }
    pageToken = data?.nextPageToken;
  } while (pageToken);
  return out;
};

export interface ExternalBusyRange {
  start: Date;
  end: Date;
}

const busyCache = new Map<string, { at: number; ranges: ExternalBusyRange[] }>();
const BUSY_CACHE_MS = 60_000;

/**
 * Busy time added to the calendar by people (not by this site) between two instants.
 * Fails open: if Google is unreachable the website keeps working on its own data.
 */
export const getExternalBusyRanges = async (timeMin: Date, timeMax: Date): Promise<ExternalBusyRange[]> => {
  if (!isGoogleCalendarEnabled(true)) return [];
  const key =`${timeMin.toISOString()}|${timeMax.toISOString()}`;
  const hit = busyCache.get(key);
  if (hit && Date.now() - hit.at < BUSY_CACHE_MS) return hit.ranges;

  try {
    const ranges: ExternalBusyRange[] = [];
    let pageToken: string | undefined;
    do {
      const data = await gcal("GET", "/events", undefined, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: "true",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {})
      });
      for (const ev of data?.items || []) {
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        if (ev.extendedProperties?.private?.source === SYNC_SOURCE) continue;
        const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : ev.start?.date ? nyMidnight(ev.start.date) : null;
        const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : ev.end?.date ? nyMidnight(ev.end.date) : null;
        if (start && end && end > start) ranges.push({ start, end });
      }
      pageToken = data?.nextPageToken;
    } while (pageToken);

    busyCache.set(key, { at: Date.now(), ranges });
    if (busyCache.size > 500) busyCache.clear();
    return ranges;
  } catch (err: any) {
    logger.error("[Google Calendar] Could not read busy times; continuing without them", { error: err.message });
    return [];
  }
};

/* ───────── New York wall-clock helpers ───────── */

const nyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: VENUE_TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23"
});

/** UTC instant for a New York wall-clock date/time (DST-aware). */
export const nyToUtc = (ymd: string, hours = 0, minutes = 0): Date => {
  const [y, m, d] = ymd.split("-").map(Number);
  const nominal = new Date(Date.UTC(y, m - 1, d, hours, minutes));
  const p: Record<string, number> = {};
  for (const part of nyFormatter.formatToParts(nominal)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const nyAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute);
  return new Date(nominal.getTime() + (nominal.getTime() - nyAsUtc));
};

const nyMidnight = (ymd: string) => nyToUtc(ymd, 0, 0);

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of a Date stored as UTC midnight of a calendar day. */
export const ymdOf = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/** Adds whole days to a "YYYY-MM-DD" string. */
export const addDays = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Local "YYYY-MM-DDTHH:MM:00" for a day plus minutes from that day's midnight (may roll into later days). */
export const localDateTime = (ymd: string, minutesFromMidnight: number): string => {
  const dayOffset = Math.floor(minutesFromMidnight / 1440);
  const mins = minutesFromMidnight - dayOffset * 1440;
  return `${addDays(ymd, dayOffset)}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;
};

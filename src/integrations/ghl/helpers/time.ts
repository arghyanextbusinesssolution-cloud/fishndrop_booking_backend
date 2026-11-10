import logger from "../../../config/logger";
import { VENUE_TIMEZONE } from "../config";

export interface EventTimes {
  eventStartTime: string;
  eventEndTime: string;
  eventStartIso: string;
  eventEndIso: string;
  timezone: string;
}

const nyPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: VENUE_TIMEZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false
});

/**
 * Converts a local calendar date/time in America/New_York into the true UTC instant.
 * Handles DST (EDT = UTC-4, EST = UTC-5). Never treats NY wall-clock hours as UTC.
 */
export const getNewYorkUtcDate = (
  year: number,
  month: number, // 1-12
  day: number,
  hours: number, // 0-23
  minutes: number
): Date => {
  const nominalUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));

  const partMap: Record<string, number> = {};
  for (const part of nyPartsFormatter.formatToParts(nominalUtc)) {
    if (part.type !== "literal") partMap[part.type] = parseInt(part.value, 10);
  }
  if (partMap.hour === 24) partMap.hour = 0;

  const nyAsUtc = new Date(
    Date.UTC(partMap.year, partMap.month - 1, partMap.day, partMap.hour, partMap.minute, partMap.second || 0)
  );

  const offsetMs = nominalUtc.getTime() - nyAsUtc.getTime();
  return new Date(nominalUtc.getTime() + offsetMs);
};

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

const to12h = (hours24: number, minutes: number) => {
  const period = hours24 >= 12 ? "PM" : "AM";
  const h12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${h12}:${pad2(minutes)} ${period}`;
};

/** Parses "7:00 PM", "19:00", "7:30pm" → { hours, minutes } in 24h. */
export const parseTimeString = (timeStr: string): { hours: number; minutes: number } => {
  let hours = 0;
  let minutes = 0;

  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (match) {
    hours = parseInt(match[1], 10);
    minutes = parseInt(match[2], 10);
    const meridian = match[3]?.toUpperCase();
    if (meridian === "PM" && hours < 12) hours += 12;
    if (meridian === "AM" && hours === 12) hours = 0;
  } else {
    const parts = timeStr.split(":").map(Number);
    if (!isNaN(parts[0])) hours = parts[0];
    if (!isNaN(parts[1])) minutes = parts[1];
  }
  return { hours, minutes };
};

/**
 * Human-readable 12h start/end times plus true UTC ISO strings anchored in the venue timezone.
 */
export const calculateEventTimes = (dateStr: string, timeStr: string, durationHours: number = 5): EventTimes => {
  if (!timeStr) {
    return { eventStartTime: "", eventEndTime: "", eventStartIso: "", eventEndIso: "", timezone: VENUE_TIMEZONE };
  }

  const { hours, minutes } = parseTimeString(timeStr);
  const durationMinutes = Math.round((durationHours || 5) * 60);

  const eventStartTime = to12h(hours, minutes);
  const totalEndMinutes = hours * 60 + minutes + durationMinutes;
  const eventEndTime = to12h(Math.floor(totalEndMinutes / 60) % 24, totalEndMinutes % 60);

  let eventStartIso = "";
  let eventEndIso = "";
  try {
    if (dateStr) {
      const cleanDate = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
      const [year, month, day] = cleanDate.split("-").map(Number);
      if (year && month && day) {
        const start = getNewYorkUtcDate(year, month, day, hours, minutes);
        eventStartIso = start.toISOString();
        eventEndIso = new Date(start.getTime() + durationMinutes * 60_000).toISOString();
      }
    }
  } catch (err: any) {
    logger.warn("[GHL] Error generating America/New_York ISO dates", { error: err?.message, dateStr, timeStr });
  }

  return { eventStartTime, eventEndTime, eventStartIso, eventEndIso, timezone: VENUE_TIMEZONE };
};

/** Date | string → "YYYY-MM-DD" (or "" when missing). */
export const toDateOnly = (value: unknown): string => {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().split("T")[0];
  return String(value).split("T")[0];
};

/** "2026-11-08" → "Sunday, November 8, 2026". Returns input on failure. */
export const formatLongDate = (dateOnly: string): string => {
  if (!dateOnly) return "";
  try {
    const [y, m, d] = dateOnly.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      timeZone: VENUE_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  } catch {
    return dateOnly;
  }
};

/** Optional date-ish value → ISO string or "". */
export const toIsoOrEmpty = (value: unknown): string => {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value as string);
  return isNaN(d.getTime()) ? "" : d.toISOString();
};

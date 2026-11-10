import { getNewYorkUtcDate, parseTimeString } from "../integrations/ghl/helpers/time";

/** Ticket sales close this many minutes before the event's start time. */
export const SALES_CLOSE_MINUTES = 5;

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Event start instant (UTC) — event.date is stored as UTC midnight of the calendar day; startTime is NY wall-clock. */
export const getEventStartAt = (event: { date: Date | string; startTime: string }): Date | null => {
  if (!event?.date || !event.startTime) return null;
  const d = new Date(event.date);
  if (isNaN(d.getTime())) return null;
  const { hours, minutes } = parseTimeString(event.startTime);
  return getNewYorkUtcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hours, minutes);
};

export const getSalesCloseAt = (event: { date: Date | string; startTime: string }): Date | null => {
  const start = getEventStartAt(event);
  return start ? new Date(start.getTime() - SALES_CLOSE_MINUTES * 60 * 1000) : null;
};

export const isSalesClosed = (event: { date: Date | string; startTime: string }, now = new Date()): boolean => {
  const close = getSalesCloseAt(event);
  return !!close && now.getTime() >= close.getTime();
};

/** Fields the public event page needs to show/close ticket sales. */
export const salesWindow = (event: { date: Date | string; startTime: string }) => {
  const startAt = getEventStartAt(event);
  const closeAt = getSalesCloseAt(event);
  return {
    eventStartAt: startAt?.toISOString() ?? null,
    salesCloseAt: closeAt?.toISOString() ?? null,
    salesClosed: isSalesClosed(event),
    salesCloseMinutes: SALES_CLOSE_MINUTES
  };
};

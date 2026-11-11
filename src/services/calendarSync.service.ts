import Booking, { IBooking } from "../models/Booking";
import Event, { IEvent } from "../models/Event";
import User from "../models/User";
import logger from "../config/logger";
import { timeToMinutes } from "../utils/time.utils";
import {
  deleteCalendarEvent,
  isGoogleCalendarEnabled,
  listSyncedCalendarEvents,
  localDateTime,
  upsertCalendarEvent,
  ymdOf
} from "./googleCalendar.service";
import { VENUE_HOLDING_EVENT_STATUSES, eventDurationMins } from "./venueAvailability.service";

/**
 * Pushes venue bookings and Tropica promoter events to Google Calendar.
 *
 * Google event ids are derived from our Mongo ids (hex is valid base32hex), so every sync is an
 * idempotent upsert/delete — retries and concurrent saves can never create duplicates.
 * `googleSyncStatus` records the last outcome so the reconcile job can retry failures.
 */

const VENUE_LOCATION = "Tropica Sanctuary NYC, Brooklyn, NY";

const bookingCalId = (id: string) => `fndb${id}`;
const eventCalId = (id: string) => `fnde${id}`;

type SyncStatus = "synced" | "removed" | "failed";

/* ───────── Private venue bookings ───────── */

const bookingShouldBeOnCalendar = (b: IBooking) => b.bookingType === "private_event" && b.status === "confirmed";

export const syncBookingToCalendar = async (booking: IBooking): Promise<void> => {
  if (booking.bookingType !== "private_event") return;
  const id = booking._id.toString();
  logger.info(
    `[Google Calendar] Venue booking ${id} saved (status=${booking.status}, payment=${booking.paymentStatus}, ${ymdOf(booking.bookingDate)} ${booking.bookingTime})`
  );
  if (!isGoogleCalendarEnabled()) return;
  // Never on the calendar (e.g. a fresh unpaid hold) → nothing to remove
  if (!bookingShouldBeOnCalendar(booking) && !booking.googleSyncStatus) {
    logger.info(`[Google Calendar]   waiting — booking ${id} is "${booking.status}"; it is added once confirmed (deposit paid)`);
    return;
  }
  let status: SyncStatus;

  try {
    if (bookingShouldBeOnCalendar(booking) && booking.bookingDate && booking.bookingTime) {
      const day = ymdOf(booking.bookingDate);
      const start = timeToMinutes(booking.bookingTime); // after-midnight times roll to the next day
      const end = start + (booking.durationHours || 5) * 60;
      const paid =
        booking.paymentStatus === "paid" ? "Paid in full" : booking.paymentStatus === "deposit_paid" ? "Deposit paid" : "Unpaid";
      const extras = [booking.needDj && "DJ", booking.needPhotographer && "Photographer"].filter(Boolean).join(", ");

      await upsertCalendarEvent({
        id: bookingCalId(id),
        kind: "booking",
        refId: id,
        summary: `Private Event – ${booking.customerName} (${booking.partySize} guests)`,
        description: [
          `Venue buyout${booking.occasion ? ` · ${booking.occasion}` : ""}`,
          `Guest: ${booking.customerName}`,
          `Phone: ${booking.customerPhone}`,
          `Email: ${booking.customerEmail}`,
          `Party size: ${booking.partySize}`,
          `Duration: ${booking.durationHours || 5}h`,
          extras && `Extras: ${extras}`,
          `Payment: ${paid}`,
          booking.notes && `Notes: ${booking.notes}`,
          `Booking ID: ${id}`
        ]
          .filter(Boolean)
          .join("\n"),
        startLocal: localDateTime(day, start),
        endLocal: localDateTime(day, end),
        location: VENUE_LOCATION
      });
      status = "synced";
    } else {
      await deleteCalendarEvent(bookingCalId(id));
      status = "removed";
    }
  } catch (err: any) {
    logger.error("[Google Calendar] Booking sync failed", { bookingId: id, error: err.message });
    status = "failed";
  }

  await Booking.updateOne({ _id: booking._id }, { $set: { googleSyncStatus: status, googleSyncedAt: new Date() } });
};

/**
 * Removes calendar entries for records that were hard-deleted from the database.
 * Called automatically by the Booking/Event delete hooks; failures are cleaned up by the leftover sweep.
 */
export const removeDeletedFromCalendar = async (kind: "booking" | "event", ids: string[]): Promise<void> => {
  if (!ids.length || !isGoogleCalendarEnabled()) return;
  for (const id of ids) {
    logger.info(`[Google Calendar] ${kind === "booking" ? "Venue booking" : "Promoter event"} ${id} deleted on website → removing from calendar`);
    try {
      await deleteCalendarEvent(kind === "booking" ? bookingCalId(id) : eventCalId(id));
    } catch (err: any) {
      logger.error(`[Google Calendar]   ✗ could not remove deleted ${kind} (will retry in the leftover sweep)`, { id, error: err.message });
    }
  }
};

/* ───────── Promoter events at Tropica ───────── */

const eventShouldBeOnCalendar = (e: IEvent) =>
  e.venueType === "tropica" && VENUE_HOLDING_EVENT_STATUSES.includes(e.status);

export const syncEventToCalendar = async (event: IEvent): Promise<void> => {
  const id = event._id.toString();
  logger.info(`[Google Calendar] Promoter event ${id} saved (status=${event.status}, venue=${event.venueType}, ${ymdOf(event.date)} ${event.startTime}–${event.endTime})`);
  if (!isGoogleCalendarEnabled()) return;
  if (!eventShouldBeOnCalendar(event) && !event.googleSyncStatus) {
    logger.info(`[Google Calendar]   skipped — only Tropica events awaiting approval or published are added`);
    return;
  }
  let status: SyncStatus;

  try {
    if (eventShouldBeOnCalendar(event)) {
      const day = ymdOf(event.date);
      const [sh, sm] = event.startTime.split(":").map(Number);
      const start = sh * 60 + sm;
      const end = start + eventDurationMins(event.startTime, event.endTime);
      const tentative = event.status === "pending_approval";
      const promoter = await User.findById(event.promoter).select("name email phone companyName").lean();

      await upsertCalendarEvent({
        id: eventCalId(id),
        kind: "event",
        refId: id,
        tentative,
        summary: `${tentative ? "[TENTATIVE] " : ""}Promoter Event – ${event.title}`,
        description: [
          tentative ? "Status: Awaiting approval (venue held)" : "Status: Approved & published",
          promoter && `Promoter: ${promoter.name}${promoter.companyName ? ` (${promoter.companyName})` : ""}`,
          promoter?.phone && `Phone: ${promoter.phone}`,
          promoter?.email && `Email: ${promoter.email}`,
          `Tickets: ${event.ticketTiers.reduce((s, t) => s + t.quantity, 0)} across ${event.ticketTiers.length} tier(s)`,
          `Event ID: ${id}`
        ]
          .filter(Boolean)
          .join("\n"),
        startLocal: localDateTime(day, start),
        endLocal: localDateTime(day, end),
        location: VENUE_LOCATION
      });
      status = "synced";
    } else {
      await deleteCalendarEvent(eventCalId(id));
      status = "removed";
    }
  } catch (err: any) {
    logger.error("[Google Calendar] Event sync failed", { eventId: id, error: err.message });
    status = "failed";
  }

  await Event.updateOne({ _id: event._id }, { $set: { googleSyncStatus: status, googleSyncedAt: new Date() } });
};

/* ───────── Reconcile (safety net for updates that bypass save hooks, and for retries) ───────── */

let reconciling = false;
let lastSweepAt = 0;
const SWEEP_EVERY_MS = 30 * 60 * 1000;

/**
 * Deletes calendar entries this site created whose booking/event was deleted, cancelled or
 * otherwise no longer belongs on the calendar — catches anything a direct delete missed.
 */
const sweepLeftoverCalendarEntries = async (since: Date): Promise<void> => {
  try {
    const entries = await listSyncedCalendarEvents(since, new Date(Date.now() + 3 * 365 * 24 * 3600 * 1000));
    if (!entries.length) return;

    const bookingIds = entries.filter((e) => e.kind === "booking").map((e) => e.refId);
    const eventIds = entries.filter((e) => e.kind === "event").map((e) => e.refId);
    const [liveBookings, liveEvents] = await Promise.all([
      Booking.find({ _id: { $in: bookingIds } }).select("bookingType status"),
      Event.find({ _id: { $in: eventIds } }).select("venueType status")
    ]);
    const keepBooking = new Set(liveBookings.filter(bookingShouldBeOnCalendar).map((b) => b._id.toString()));
    const keepEvent = new Set(liveEvents.filter(eventShouldBeOnCalendar).map((e) => e._id.toString()));

    const stale = entries.filter((e) => (e.kind === "booking" ? !keepBooking.has(e.refId) : !keepEvent.has(e.refId)));
    for (const e of stale) {
      logger.info(`[Google Calendar] Leftover sweep: ${e.kind} ${e.refId} no longer on the website → removing calendar entry`);
      await deleteCalendarEvent(e.id).catch((err) =>
        logger.error("[Google Calendar]   ✗ leftover removal failed", { id: e.id, error: err.message })
      );
    }
    // Keep DB flags honest for records that still exist
    const staleBookingIds = stale.filter((e) => e.kind === "booking").map((e) => e.refId);
    const staleEventIds = stale.filter((e) => e.kind === "event").map((e) => e.refId);
    if (staleBookingIds.length) await Booking.updateMany({ _id: { $in: staleBookingIds } }, { $set: { googleSyncStatus: "removed" } });
    if (staleEventIds.length) await Event.updateMany({ _id: { $in: staleEventIds } }, { $set: { googleSyncStatus: "removed" } });
  } catch (err: any) {
    logger.error("[Google Calendar] Leftover sweep failed", { error: err.message });
  }
};

export const reconcileCalendar = async (): Promise<void> => {
  if (reconciling || !isGoogleCalendarEnabled(true)) return;
  reconciling = true;
  try {
    const since = new Date(Date.now() - 2 * 24 * 3600 * 1000); // ignore history

    const bookings = await Booking.find({
      bookingType: "private_event",
      bookingDate: { $gte: since },
      $or: [
        { googleSyncStatus: "failed" },
        { status: "confirmed", googleSyncStatus: { $ne: "synced" } },
        { status: { $ne: "confirmed" }, googleSyncStatus: "synced" }
      ]
    }).limit(50);
    for (const b of bookings) await syncBookingToCalendar(b);

    const events = await Event.find({
      date: { $gte: since },
      $or: [
        { googleSyncStatus: "failed" },
        { venueType: "tropica", status: { $in: VENUE_HOLDING_EVENT_STATUSES }, googleSyncStatus: { $ne: "synced" } },
        { googleSyncStatus: "synced", $or: [{ venueType: { $ne: "tropica" } }, { status: { $nin: VENUE_HOLDING_EVENT_STATUSES } }] }
      ]
    }).limit(50);
    for (const e of events) await syncEventToCalendar(e);

    if (bookings.length || events.length) {
      logger.info(`[Google Calendar] Reconciled ${bookings.length} booking(s), ${events.length} event(s)`);
    }

    if (Date.now() - lastSweepAt > SWEEP_EVERY_MS) {
      lastSweepAt = Date.now();
      await sweepLeftoverCalendarEntries(since);
    }
  } catch (err: any) {
    logger.error("[Google Calendar] Reconcile failed", { error: err.message });
  } finally {
    reconciling = false;
  }
};

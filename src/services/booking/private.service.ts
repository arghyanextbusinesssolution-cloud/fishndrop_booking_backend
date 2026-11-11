import SlotLock from "../../models/SlotLock";
import Table from "../../models/Table";
import { isOverlapping, buildDayRange, timeToMinutes, TIME_SLOTS } from "../../utils/time.utils";
import { cleanupExpiredPendingBookings } from "../../utils/cleanupExpiredBookings";
import { getSessionBusyBlocks, overlapsAny } from "../venueAvailability.service";

/** "YYYY-MM-DD" for any date input buildDayRange accepts. */
const toYmd = (date: string) => buildDayRange(date).parsedDate.toISOString().slice(0, 10);

/** True when the requested venue window [startTime, startTime + durationHours) is free for a private buyout. */
export const isPrivateSlotAvailable = async (
  date: string,
  startTime: string,
  durationHours: number,
  excludeBookingId?: string
): Promise<boolean> => {
  const { slots } = await getPrivateEventAvailability(date, durationHours, excludeBookingId);
  return slots.some((s) => s.slot === startTime && s.isAvailable);
};

/**
 * Hourly start times for a private venue buyout on `date`. A start is available only when the whole
 * window is clear of: other buyouts, table reservations, admin locks, Tropica promoter events and
 * entries added by hand to the venue's Google Calendar (see venueAvailability.service).
 */
export const getPrivateEventAvailability = async (date: string, duration: number, excludeBookingId?: string) => {
  await cleanupExpiredPendingBookings();

  const [allTables, blocks] = await Promise.all([
    Table.find(),
    getSessionBusyBlocks(toYmd(date), { excludeBookingId })
  ]);

  const totalCapacity = allTables.reduce((sum, table) => sum + table.capacity, 0);

  const HOURLY_SLOTS: string[] = [];
  for (let i = 10; i <= 23; i++) {
    HOURLY_SLOTS.push(`${i < 10 ? "0" : ""}${i}:00`);
  }

  const slots = HOURLY_SLOTS.map((timeSlot) => {
    const startMins = timeToMinutes(timeSlot);
    const endMins = startMins + duration * 60;

    // Blocks must end by 3 AM next day (3*60 + 24*60 = 1620 mins in our model)
    const tooLate = endMins > 27 * 60;
    const conflict = tooLate ? undefined : overlapsAny(blocks, startMins, endMins);
    const isAvailable = !tooLate && !conflict;

    return {
      slot: timeSlot,
      isAvailable,
      message: isAvailable
        ? "Available"
        : conflict?.source === "promoter_event"
          ? "Reserved for a venue event"
          : "Venue partially or fully booked"
    };
  });

  return { slots, totalCapacity };
};

export const createSlotLocksForPrivateEvent = async (bookingId: any, bookingDate: Date, bookingTime: string, durationHours: number) => {
  const eventDurationMins = durationHours * 60;

  for (const timeSlot of TIME_SLOTS) {
    if (isOverlapping(bookingTime, eventDurationMins, timeSlot, 120)) {
      await SlotLock.create({
        bookingDate,
        bookingTime: timeSlot,
        isLocked: true,
        reason: "Private Event Buyout",
        eventId: bookingId
      });
    }
  }
};

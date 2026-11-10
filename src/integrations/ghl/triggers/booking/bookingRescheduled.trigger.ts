import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";
import type { PreviousSchedule } from "../../types";

/**
 * Booking moved to a new date/time. Payload carries workflow-reset instructions,
 * the new America/New_York eventEndIso and the previous date/time.
 * Event: "booking_rescheduled" · Tag: "Booking Rescheduled" · Webhook: general
 */
export const sendGHLRescheduleEvent = async (booking: any, previous?: PreviousSchedule): Promise<void> => {
  await safeTrigger("booking_rescheduled", () =>
    bookingDispatch(booking, {
      event: "booking_rescheduled",
      leadStatus: "rescheduled",
      ghlTag: "Booking Rescheduled",
      previousBookingDate: previous?.previousBookingDate,
      previousBookingTime: previous?.previousBookingTime
    })
  );
};

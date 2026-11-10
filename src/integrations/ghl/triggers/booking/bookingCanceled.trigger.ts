import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";

/**
 * Booking canceled.
 * Event: "booking_canceled" · Tag: "Booking Canceled" · Webhook: general
 */
export const sendGHLCancelEvent = async (booking: any, reason?: string): Promise<void> => {
  await safeTrigger("booking_canceled", () =>
    bookingDispatch(booking, {
      event: "booking_canceled",
      leadStatus: "canceled",
      ghlTag: "Booking Canceled",
      reason
    })
  );
};

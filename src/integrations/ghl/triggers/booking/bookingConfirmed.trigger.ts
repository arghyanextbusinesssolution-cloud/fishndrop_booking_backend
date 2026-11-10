import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";
import type { PaidNowExtra } from "../../types";

/**
 * Deposit or full payment verified.
 * Event: "booking_confirmed" · Tag: "Booking Confirmed" · Webhook: general
 */
export const sendGHLBookingEvent = async (booking: any, extra?: PaidNowExtra): Promise<void> => {
  await safeTrigger("booking_confirmed", () =>
    bookingDispatch(booking, {
      event: "booking_confirmed",
      leadStatus: "booking",
      ghlTag: "Booking Confirmed",
      paidNow: extra?.paidNow
    })
  );
};

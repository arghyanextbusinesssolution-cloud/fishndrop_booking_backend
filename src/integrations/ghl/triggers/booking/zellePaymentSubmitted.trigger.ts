import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";
import type { PaidNowExtra } from "../../types";

/**
 * Zelle proof submitted, awaiting verification.
 * Event: "zelle_payment_submitted" · Tag: "Zelle Payment Pending" · Webhook: general
 */
export const sendGHLZellePendingEvent = async (booking: any, extra?: PaidNowExtra): Promise<void> => {
  await safeTrigger("zelle_payment_submitted", () =>
    bookingDispatch(booking, {
      event: "zelle_payment_submitted",
      leadStatus: "lead",
      ghlTag: "Zelle Payment Pending",
      paidNow: extra?.paidNow
    })
  );
};

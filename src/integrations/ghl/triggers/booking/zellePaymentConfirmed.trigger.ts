import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";
import type { PaidNowExtra } from "../../types";

/**
 * Zelle deposit or balance installment verified.
 * Event: "zelle_payment_confirmed" · Tag: "Zelle Payment Confirmed" · Webhook: zelleConfirmed (dedicated)
 */
export const sendGHLZelleConfirmedEvent = async (booking: any, extra?: PaidNowExtra): Promise<void> => {
  await safeTrigger("zelle_payment_confirmed", () =>
    bookingDispatch(
      booking,
      {
        event: "zelle_payment_confirmed",
        leadStatus: "booking",
        ghlTag: "Zelle Payment Confirmed",
        paidNow: extra?.paidNow
      },
      "zelleConfirmed"
    )
  );
};

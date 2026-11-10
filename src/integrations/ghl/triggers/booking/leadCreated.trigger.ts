import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";

/**
 * Guest submitted the reservation form.
 * Event: "lead_created" · Tag: "Website Lead" · Webhook: general
 */
export const sendGHLLeadEvent = async (booking: any): Promise<void> => {
  await safeTrigger("lead_created", () =>
    bookingDispatch(booking, { event: "lead_created", leadStatus: "lead", ghlTag: "Website Lead" })
  );
};

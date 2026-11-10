import { safeTrigger } from "../../client";
import { nowIso, toId } from "../../helpers/common";

/**
 * Guest registered for a private-event invitation and received an admission pass.
 * Event: "guest_pass_issued" · Tag: "Private Event Guest Pass" · Webhook: general
 */
export const sendGHLGuestPassIssuedEvent = async (pass: any, booking: any): Promise<void> => {
  await safeTrigger("guest_pass_issued", () => ({
    webhook: "general",
    event: "guest_pass_issued",
    ref: pass.passCode,
    payload: {
      event: "guest_pass_issued",
      leadStatus: "booking",
      ghlTag: "Private Event Guest Pass",
      passCode: pass.passCode,
      bookingId: toId(booking),
      occasion: booking?.occasion || "Private Event",
      eventDate: booking?.bookingDate,
      eventTime: booking?.bookingTime,
      guestName: pass.guestName,
      guestEmail: pass.guestEmail || "",
      guestPhone: pass.guestPhone || "",
      hostName: booking?.customerName,
      status: pass.status,
      timestamp: nowIso()
    }
  }));
};

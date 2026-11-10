import { safeTrigger } from "../../client";
import { nowIso, toId } from "../../helpers/common";

/**
 * Guest told the host they are not attending; the spot is open again on the guest list.
 * Event: "guest_pass_cancelled" · Tag: "Private Event Guest Not Attending" · Webhook: general
 */
export const sendGHLGuestPassCancelledEvent = async (pass: any, booking: any, spotsRemaining: number): Promise<void> => {
  await safeTrigger("guest_pass_cancelled", () => ({
    webhook: "general",
    event: "guest_pass_cancelled",
    ref: pass.passCode,
    payload: {
      event: "guest_pass_cancelled",
      leadStatus: "booking",
      ghlTag: "Private Event Guest Not Attending",
      passCode: pass.passCode,
      bookingId: toId(booking),
      occasion: booking?.occasion || "Private Event",
      eventDate: booking?.bookingDate,
      eventTime: booking?.bookingTime,
      guestName: pass.guestName,
      guestEmail: pass.guestEmail || "",
      guestPhone: pass.guestPhone || "",
      hostName: booking?.customerName,
      hostEmail: booking?.customerEmail || "",
      hostPhone: booking?.customerPhone || "",
      spotsRemaining,
      timestamp: nowIso()
    }
  }));
};

import { safeTrigger } from "../../client";
import { nowIso, toId } from "../../helpers/common";

/**
 * Guest pass scanned and checked in at the door for a private event.
 * Event: "guest_pass_checked_in" · Tag: "Guest Pass Checked In" · Webhook: general
 */
export const sendGHLGuestPassCheckedInEvent = async (pass: any, booking: any, staffName: string): Promise<void> => {
  await safeTrigger("guest_pass_checked_in", () => ({
    webhook: "general",
    event: "guest_pass_checked_in",
    ref: pass.passCode,
    payload: {
      event: "guest_pass_checked_in",
      leadStatus: "booking",
      ghlTag: "Guest Pass Checked In",
      passCode: pass.passCode,
      bookingId: toId(booking),
      occasion: booking?.occasion || "Private Event",
      guestName: pass.guestName,
      guestEmail: pass.guestEmail || "",
      guestPhone: pass.guestPhone || "",
      checkedInAt: pass.checkedInAt || nowIso(),
      checkedInBy: staffName,
      timestamp: nowIso()
    }
  }));
};

import { safeTrigger } from "../../client";
import { nowIso } from "../../helpers/common";

/**
 * Staff scanned and validated a ticket at the door.
 * Event: "ticket_checked_in" · Tag: "Ticket Checked In" · Webhook: general
 */
export const sendGHLTicketCheckedInEvent = async (ticket: any, event: any, staffName: string): Promise<void> => {
  await safeTrigger("ticket_checked_in", () => ({
    webhook: "general",
    event: "ticket_checked_in",
    ref: ticket.ticketCode,
    payload: {
      event: "ticket_checked_in",
      leadStatus: "booking",
      ghlTag: "Ticket Checked In",
      ticketCode: ticket.ticketCode,
      eventTitle: event?.title,
      // The person who actually walked in (guest seat holder, or the buyer)
      customerName: ticket.holderName || ticket.customerName,
      customerEmail: ticket.holderStatus ? ticket.holderEmail || "" : ticket.customerEmail,
      customerPhone: ticket.holderPhone || ticket.customerPhone,
      email: ticket.holderStatus ? ticket.holderEmail || "" : ticket.customerEmail,
      phone: ticket.holderPhone || ticket.customerPhone,
      isGuestSeat: !!ticket.holderStatus && !ticket.isBuyerSeat,
      buyerName: ticket.customerName,
      tierName: ticket.tierName,
      checkedInAt: ticket.checkedInAt || nowIso(),
      checkedInBy: staffName,
      timestamp: nowIso()
    }
  }));
};

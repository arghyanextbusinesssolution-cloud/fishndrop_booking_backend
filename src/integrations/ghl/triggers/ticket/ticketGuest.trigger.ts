import { getPublicLinkBase } from "../../config";
import { safeTrigger } from "../../client";
import { nowIso, splitName, toId } from "../../helpers/common";
import { toDateOnly } from "../../helpers/time";

/**
 * Guest-sharing lifecycle for multi-ticket event orders.
 *
 *   ticket_guest_requested  → notify BUYER   ("Sam wants one of your tickets")
 *   ticket_guest_accepted   → notify GUEST   ("You're in, your ticket is ready")
 *   ticket_guest_rejected   → notify GUEST   ("The buyer declined your request")
 *   ticket_guest_cancelled  → notify BUYER   ("Sam gave their ticket back")
 *
 * `email` / `phone` / `firstName` always identify the person GHL should message.
 * Webhook: general · Tag: "Ticket Guest <Action>"
 */
export type TicketGuestAction = "requested" | "accepted" | "rejected" | "cancelled";

const NOTIFY_BUYER: Record<TicketGuestAction, boolean> = {
  requested: true,
  accepted: false,
  rejected: false,
  cancelled: true
};

const TAG: Record<TicketGuestAction, string> = {
  requested: "Ticket Guest Requested",
  accepted: "Ticket Guest Accepted",
  rejected: "Ticket Guest Rejected",
  cancelled: "Ticket Guest Cancelled"
};

export interface TicketGuestInfo {
  name: string;
  phone: string;
  email?: string;
}

export const sendGHLTicketGuestEvent = async (
  action: TicketGuestAction,
  order: any,
  event: any,
  ticket: any,
  guest: TicketGuestInfo,
  stats: { seatsTotal: number; seatsOpen: number; seatsAccepted: number; seatsPending: number }
): Promise<void> => {
  const name = `ticket_guest_${action}`;
  await safeTrigger(name, () => {
    const site = getPublicLinkBase();
    const toBuyer = NOTIFY_BUYER[action];
    const recipient = toBuyer
      ? { name: order.customerName, email: order.customerEmail || "", phone: order.customerPhone || "" }
      : { name: guest.name, email: guest.email || "", phone: guest.phone || "" };
    const { firstName, lastName } = splitName(recipient.name, "Guest");

    return {
      webhook: "general",
      event: name,
      ref: `${order.orderNumber}:${ticket?.ticketCode || ""}`,
      payload: {
        event: name,
        leadStatus: "booking",
        ghlTag: TAG[action],
        recipient: toBuyer ? "buyer" : "guest",

        // Person GHL should notify
        customerName: recipient.name,
        firstName,
        lastName,
        email: recipient.email,
        phone: recipient.phone,

        // Both sides
        buyerName: order.customerName,
        buyerFirstName: splitName(order.customerName, "Your friend").firstName,
        buyerEmail: order.customerEmail || "",
        buyerPhone: order.customerPhone || "",
        guestName: guest.name,
        guestFirstName: splitName(guest.name, "Guest").firstName,
        guestEmail: guest.email || "",
        guestPhone: guest.phone,

        // Order / seat
        orderNumber: order.orderNumber,
        orderId: toId(order),
        ticketCode: ticket?.ticketCode || "",
        tierName: ticket?.tierName || "",
        seatsTotal: stats.seatsTotal,
        seatsOpen: stats.seatsOpen,
        seatsAccepted: stats.seatsAccepted,
        seatsPending: stats.seatsPending,
        guestCancelDeadline: order.guestCancelDeadline ? new Date(order.guestCancelDeadline).toISOString() : "",

        // Links
        manageGuestsUrl: `${site}/user/tickets/`,
        myTicketsUrl: `${site}/user/tickets/`,
        shareUrl: order.shareToken ? `${site}/tickets/share/${order.shareToken}/` : "",

        // Event
        eventId: toId(event),
        eventTitle: event?.title || "",
        eventDate: event?.date instanceof Date ? toDateOnly(event.date) : event?.date || "",
        startTime: event?.startTime || "",
        venueName: event?.venueName || "",
        venueAddress: event?.venueAddress || "",
        timestamp: nowIso()
      }
    };
  });
};

import { getPublicLinkBase } from "../../config";
import { safeTrigger } from "../../client";
import { nowIso, splitName, toId } from "../../helpers/common";
import { toDateOnly, toIsoOrEmpty } from "../../helpers/time";
import { birthdayFields } from "../../../../utils/dob.utils";

const to12h = (t?: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  if (!m) return t || "";
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
};
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

export interface TicketPurchaseContext {
  promoter?: any;
  admins?: any[];
  eventTicketsSold?: number;
  eventCapacity?: number;
}

/**
 * Customer paid for event tickets.
 * One webhook, three notifications in GHL: the customer (confirmation + QR links),
 * the promoter ("you sold N tickets") and the admins (sale alert).
 * Event: "ticket_purchased" · Tag: "Ticket Purchased" · Webhook: ticketPurchased
 */
export const sendGHLTicketPurchasedEvent = async (
  order: any,
  event: any,
  tickets: any[],
  ctx: TicketPurchaseContext = {}
): Promise<void> => {
  await safeTrigger("ticket_purchased", () => {
    const site = getPublicLinkBase();
    const list = Array.isArray(tickets) ? tickets : [];
    const items: any[] = Array.isArray(order.items) ? order.items : [];
    const ticketUrl = (t: any) => `${site}/tickets/${t.qrCodeToken}/`;
    const { firstName, lastName } = splitName(order.customerName, "Guest");
    const promoter = ctx.promoter || {};
    const { firstName: promoterFirstName } = splitName(promoter.name, "Promoter");

    // Money
    const subtotal = money(order.subtotal);
    const fee = money(order.platformFee);
    const totalPaid = money(order.totalAmount);
    const feePaidBy = totalPaid > subtotal ? "customer" : "promoter";
    const promoterEarnings = money(totalPaid - fee);

    // Admins to notify: admin1Name/Email/Phone, admin2…
    const admins = (ctx.admins || []).filter((a) => a && (a.email || a.phone));
    const adminFields: Record<string, string | number> = { adminCount: admins.length };
    admins.forEach((a, i) => {
      adminFields[`admin${i + 1}Name`] = a.name || "";
      adminFields[`admin${i + 1}Email`] = a.email || "";
      adminFields[`admin${i + 1}Phone`] = a.phone || "";
    });
    adminFields.adminEmails = admins.map((a) => a.email).filter(Boolean).join(", ");
    adminFields.adminPhones = admins.map((a) => a.phone).filter(Boolean).join(", ");

    const ticketCount = list.length || items.reduce((s, i) => s + (i.quantity || 0), 0);

    return {
      webhook: "ticketPurchased",
      event: "ticket_purchased",
      ref: order.orderNumber,
      payload: {
        event: "ticket_purchased",
        leadStatus: "booking",
        ghlTag: "Ticket Purchased",

        // Customer (gets the confirmation)
        customerName: order.customerName,
        firstName,
        lastName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        email: order.customerEmail,
        phone: order.customerPhone,

        // Birthday bonus (dateOfBirth, birthMonth, birthDay, ageAtEvent, birthdayNearEvent ±7 days)
        ...birthdayFields(order.customerDob, event?.date),

        // Order & money
        orderNumber: order.orderNumber,
        orderId: toId(order),
        paidAt: toIsoOrEmpty(order.paidAt) || nowIso(),
        paymentMethod: "card",
        currency: (order.currency || "usd").toUpperCase(),
        ticketCount,
        ticketBreakdown: items.map((i) => `${i.quantity}× ${i.tierName} ($${money(i.unitPrice)})`).join(", "),
        ticketItems: items.map((i) => ({
          tier: i.tierName,
          quantity: i.quantity,
          unitPrice: money(i.unitPrice),
          subtotal: money(i.subtotal)
        })),
        subtotal,
        serviceFee: fee,
        platformFee: fee,
        totalAmount: totalPaid,
        totalPaid,
        feePaidBy,
        promoterEarnings,
        tropicaCommission: fee,

        // Tickets / QR passes
        ticketCodes: list.map((t) => t.ticketCode).join(", "),
        ticketLinks: list.map(ticketUrl).join(" | "),
        primaryTicketUrl: list[0] ? ticketUrl(list[0]) : "",
        myTicketsUrl: `${site}/user/tickets/`,
        // Extra seats: buyer shares this link; guests claim with phone OTP, buyer accepts/rejects
        shareUrl: order.shareToken ? `${site}/tickets/share/${order.shareToken}/` : "",
        extraSeats: Math.max(0, ticketCount - 1),

        // Event
        eventId: toId(event),
        eventTitle: event?.title,
        eventDate: event?.date instanceof Date ? toDateOnly(event.date) : event?.date,
        startTime: event?.startTime,
        endTime: event?.endTime,
        startTime12h: to12h(event?.startTime),
        endTime12h: to12h(event?.endTime),
        timezone: "America/New_York",
        venueName: event?.venueName,
        venueAddress: event?.venueAddress,
        venueMapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          Number.isFinite(event?.venueLat) && Number.isFinite(event?.venueLng)
            ? `${event.venueLat},${event.venueLng}`
            : `${event?.venueName || ""}, ${event?.venueAddress || ""}`
        )}`,
        flyerUrl: /^https?:\/\//i.test(event?.flyerUrl || "") ? event.flyerUrl : "",
        eventUrl: event?.slug ? `${site}/events/${event.slug}/` : "",
        eventTicketsSold: ctx.eventTicketsSold ?? "",
        eventCapacity: ctx.eventCapacity ?? "",
        eventTicketsRemaining:
          ctx.eventCapacity !== undefined && ctx.eventTicketsSold !== undefined
            ? Math.max(0, ctx.eventCapacity - ctx.eventTicketsSold)
            : "",

        // Promoter (gets "you sold tickets")
        promoterId: toId(promoter),
        promoterName: promoter.name || "",
        promoterFirstName,
        promoterEmail: promoter.email || "",
        promoterPhone: promoter.phone || "",
        promoterCompanyName: promoter.companyName || "",
        promoterSalesUrl: `${site}/promoter/bookings/`,

        // Admins (get a sale alert)
        ...adminFields,
        adminOrdersUrl: event ? `${site}/admin/events-overview/` : "",

        timestamp: nowIso()
      }
    };
  });
};

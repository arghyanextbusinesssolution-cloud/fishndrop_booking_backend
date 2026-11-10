import { getPublicLinkBase } from "../../config";
import { safeTrigger } from "../../client";
import { nowIso, splitName, toId } from "../../helpers/common";
import { toDateOnly, toIsoOrEmpty } from "../../helpers/time";
import { salesWindow } from "../../../../utils/eventTime.utils";

const to12h = (t?: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  if (!m) return t || "";
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
};

/**
 * Employee (staff) or admin approved a promoter's event → it is now live.
 * GHL sends the promoter "Hi {firstName}, your event {eventTitle} is live: {eventUrl}".
 * Event: "event_approved" · Tag: "Event Published" · Webhook: eventApproved (GHL_EVENT_APPROVED_WEBHOOK_URL)
 */
export const sendGHLEventApprovedEvent = async (event: any, promoter: any, approvedBy?: any): Promise<void> => {
  await safeTrigger("event_approved", () => {
    const eventId = toId(event);
    const site = getPublicLinkBase();
    const tiers: any[] = Array.isArray(event.ticketTiers) ? event.ticketTiers : [];
    const prices = tiers.map((t) => Number(t.price) || 0);
    const { name: promoterName, firstName, lastName } = splitName(promoter?.name, "Promoter");
    const hasPin = Number.isFinite(event.venueLat) && Number.isFinite(event.venueLng);
    const mapQuery = encodeURIComponent(hasPin ? `${event.venueLat},${event.venueLng}` : `${event.venueName}, ${event.venueAddress}`);
    const sw = salesWindow(event);

    return {
      webhook: "eventApproved",
      event: "event_approved",
      ref: eventId,
      payload: {
        event: "event_approved",
        ghlTag: "Event Published",

        // Promoter (who receives the "your event is live" message)
        promoterId: toId(promoter),
        promoterName,
        firstName,
        lastName,
        promoterEmail: promoter?.email || "",
        promoterPhone: promoter?.phone || "",
        promoterCompanyName: promoter?.companyName || "",
        email: promoter?.email || "",
        phone: promoter?.phone || "",

        // Event
        eventId,
        eventTitle: event.title,
        eventSlug: event.slug,
        eventDescription: event.description || "",
        eventStatus: event.status,
        eventDate: event.date instanceof Date ? toDateOnly(event.date) : event.date,
        startTime: event.startTime,
        endTime: event.endTime,
        startTime12h: to12h(event.startTime),
        endTime12h: to12h(event.endTime),
        timezone: "America/New_York",
        ticketSalesCloseAt: sw.salesCloseAt || "",
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        venueMapUrl: `https://www.google.com/maps/search/?api=1&query=${mapQuery}`,
        flyerUrl: /^https?:\/\//i.test(event.flyerUrl || "") ? event.flyerUrl : "",
        ticketTiersSummary: tiers.map((t) => `${t.name}: $${t.price}`).join(" | "),
        totalTicketCapacity: tiers.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0),
        lowestTicketPrice: prices.length ? Math.min(...prices) : 0,
        highestTicketPrice: prices.length ? Math.max(...prices) : 0,

        // Links
        eventUrl: `${site}/events/${event.slug}/`,
        promoterDashboardUrl: `${site}/promoter/events/`,

        // Who approved it
        approvedById: toId(approvedBy),
        approvedByName: approvedBy?.name || "",
        approvedByRole: approvedBy?.role || "",
        approvedAt: toIsoOrEmpty(event.approvedAt) || nowIso(),
        timestamp: nowIso()
      }
    };
  });
};

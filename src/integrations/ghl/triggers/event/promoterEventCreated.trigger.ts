import { getPublicLinkBase } from "../../config";
import { salesWindow } from "../../../../utils/eventTime.utils";
import { employeeFields } from "../../helpers/team";
import { safeTrigger } from "../../client";
import { nowIso, splitName, toId } from "../../helpers/common";
import { toDateOnly, toIsoOrEmpty } from "../../helpers/time";

/**
 * Promoter created a new event. Sends full event + ticket tier + promoter data.
 * Event: "promoter_event_created" · Tag: "Promoter Event Created" · Webhook: promoterEventCreated
 */
export const sendGHLPromoterEventCreatedEvent = async (event: any, promoter: any, employees: any[] = []): Promise<void> => {
  await safeTrigger("promoter_event_created", () => {
    const tiers: any[] = Array.isArray(event.ticketTiers) ? event.ticketTiers : [];
    const prices = tiers.map((t) => Number(t.price) || 0);
    const { name: promoterName, firstName, lastName } = splitName(promoter?.name);
    const eventId = toId(event);
    const site = getPublicLinkBase();
    const to12h = (t?: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
      if (!m) return t || "";
      const h = Number(m[1]);
      return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
    };
    const hasPin = Number.isFinite(event.venueLat) && Number.isFinite(event.venueLng);
    const mapQuery = encodeURIComponent(hasPin ? `${event.venueLat},${event.venueLng}` : `${event.venueName}, ${event.venueAddress}`);
    const window = salesWindow(event);

    // Every employee (staff) so GHL can notify the team: employee1Name/Email/Phone, employee2…
    const teamFields = employeeFields(employees || []);

    return {
      webhook: "promoterEventCreated",
      event: "promoter_event_created",
      ref: eventId,
      payload: {
        event: "promoter_event_created",
        ghlTag: "Promoter Event Created",
        // Event
        eventId,
        eventTitle: event.title,
        eventSlug: event.slug,
        eventDescription: event.description || "",
        eventDate: event.date instanceof Date ? toDateOnly(event.date) : event.date,
        startTime: event.startTime,
        endTime: event.endTime,
        startTime12h: to12h(event.startTime),
        endTime12h: to12h(event.endTime),
        endsNextDay: !!event.endTime && !!event.startTime && event.endTime <= event.startTime,
        timezone: "America/New_York",
        eventStartAt: window.eventStartAt || "",
        ticketSalesCloseAt: window.salesCloseAt || "",
        ticketSalesCloseMinutesBefore: window.salesCloseMinutes,
        venueType: event.venueType,
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        venueLat: hasPin ? event.venueLat : "",
        venueLng: hasPin ? event.venueLng : "",
        venueMapUrl: `https://www.google.com/maps/search/?api=1&query=${mapQuery}`,
        // Only a real link: never an embedded data: image
        flyerUrl: /^https?:\/\//i.test(event.flyerUrl || "") ? event.flyerUrl : "",
        eventStatus: event.status,
        eventUrl: `${site}/events/${event.slug}/`,
        promoterEventsUrl: `${site}/promoter/events/`,
        ticketTiers: tiers.map((t) => ({
          name: t.name,
          price: t.price,
          quantity: t.quantity,
          description: t.description || "",
          salesDeadline: toIsoOrEmpty(t.salesDeadline)
        })),
        ticketTiersSummary: tiers.map((t) => `${t.name}: $${t.price} x ${t.quantity}`).join(" | "),
        ticketTierCount: tiers.length,
        totalTicketCapacity: tiers.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0),
        lowestTicketPrice: prices.length ? Math.min(...prices) : 0,
        highestTicketPrice: prices.length ? Math.max(...prices) : 0,
        // Promoter
        promoterId: toId(promoter),
        firstName,
        lastName,
        promoterName,
        promoterEmail: promoter?.email || "",
        promoterPhone: promoter?.phone || "",
        promoterCompanyName: promoter?.companyName || "",
        promoterStatus: promoter?.promoterStatus || "",
        // Employees (team to notify)
        ...teamFields,
        createdAt: (event.createdAt instanceof Date ? event.createdAt : new Date()).toISOString(),
        timestamp: nowIso()
      }
    };
  });
};

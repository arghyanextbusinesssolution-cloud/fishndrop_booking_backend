import SystemSettings from "../models/SystemSettings";
import { getFrontendBaseUrl, normalizeBaseUrl } from "../utils/siteUrl";

/**
 * Approved business facts the AI may state. Prices are read live from SystemSettings (admin panel),
 * so changing a price in the admin panel changes what the AI quotes. Anything not listed here the AI
 * must not invent — it offers the website or a team member instead.
 *
 * Edit the STATIC_FACTS / FAQ below (or set AI_EXTRA_FACTS in .env) to teach the bot more.
 */

export const MIN_VENUE_GUESTS = 10;
export const INCLUDED_HOURS = 5;
export const MIN_DURATION = 5;
export const MAX_DURATION = 12;
export const FIRST_START = "10:00";
export const LAST_START = "23:00";
export const LATEST_END_LABEL = "3 AM";

export const CONTACT = {
  phone: "1 866-990-7422",
  email: "Bookings@tropica.nyc"
};

export interface Pricing {
  perGuestPrice: number;
  maxGuestCapacity: number;
  extraHourPrice: number;
  djPrice: number;
  photographerBasePrice: number;
  photographerExtraHourPrice: number;
  minDepositAmount: number;
}

export const getPricing = async (): Promise<Pricing> => {
  const s: any = await (SystemSettings as any).getSettings();
  return {
    perGuestPrice: s.perGuestPrice ?? 50,
    maxGuestCapacity: s.maxGuestCapacity ?? 40,
    extraHourPrice: s.extraHourPrice ?? 125,
    djPrice: s.djPrice ?? 300,
    photographerBasePrice: s.photographerBasePrice ?? 300,
    photographerExtraHourPrice: s.photographerExtraHourPrice ?? 150,
    minDepositAmount: s.minDepositAmount ?? 300
  };
};

export const siteLinks = () => {
  // Links go to real customers' phones, so never a localhost URL: AI_PUBLIC_SITE_URL wins over the dev base
  const base = normalizeBaseUrl(process.env.AI_PUBLIC_SITE_URL) || getFrontendBaseUrl();
  return {
    venue: `${base}/book-venue`,
    table: `${base}/book-table`,
    tour: `${base}/book-tour`,
    events: `${base}/events`,
    terms: `${base}/terms`
  };
};

export const buildKnowledge = (p: Pricing): string => {
  const links = siteLinks();
  const extra = process.env.AI_EXTRA_FACTS?.trim();
  return `
TROPICA NYC — APPROVED FACTS (only state what is here or what a tool returns)

What Tropica offers
- Private venue buyout: the whole venue is reserved for one group (birthdays, celebrations, corporate, showers, etc.).
- Table reservations at the restaurant/lounge (smaller groups, no buyout).
- Ticketed events hosted by promoters (customers buy tickets on the events page).
- Venue tours can be booked online.

Private venue buyout rules
- Price: $${p.perGuestPrice} per guest. Minimum ${MIN_VENUE_GUESTS} guests, maximum ${p.maxGuestCapacity} guests.
- ${INCLUDED_HOURS} hours are included. Bookings can be ${MIN_DURATION}–${MAX_DURATION} hours; each extra hour beyond ${INCLUDED_HOURS} is $${p.extraHourPrice}.
- Start times: every hour from 10 AM to 11 PM. The event must end by ${LATEST_END_LABEL}.
- Each guest gets 2 complimentary drinks.
- Add-ons: DJ $${p.djPrice}. Photographer $${p.photographerBasePrice} (covers 2 hours), +$${p.photographerExtraHourPrice} per extra photographer hour.
- Catering: optional partner catering menus can be chosen during booking (menu and prices are shown on the booking page).
- Deposit: $${p.minDepositAmount} minimum to secure the date (or the full amount if the total is lower). The remaining balance is due no later than 72 hours before the event; if it is unpaid by then, the reservation may be canceled.
- Payment: card online, or Zelle (verified by the team).
- Cancellation: canceled within 48 hours of making the booking = refunded per the terms. After 48 hours from booking, the deposit and any paid balance are non-refundable. Full terms: ${links.terms}

Booking pages
- Private venue: ${links.venue}
- Table reservation: ${links.table}
- Venue tour: ${links.tour}
- Events & tickets: ${links.events}
A booking is only confirmed after it is completed and paid on the website.

Contact
- Phone ${CONTACT.phone} · Email ${CONTACT.email}

Not known (never guess — offer a team member): exact street address/directions, parking, decorations policy, outside food/cake policy, custom or discounted pricing, kids policy, dress code, specific menu items and prices.
${extra ? `\nExtra approved facts\n${extra}` : ""}`.trim();
};

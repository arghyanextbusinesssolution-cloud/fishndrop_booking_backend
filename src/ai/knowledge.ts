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
  phone: "1-866-990-7422",
  email: "Bookings@tropica.nyc",
  address: "1007 Hegeman Avenue, Brooklyn, NY 11208"
};

export const SEATED_CAPACITY = 30;

/** Fixed links from the Tropica AI master prompt (override in .env if they ever change). */
export const EXTERNAL_LINKS = {
  walkthrough: process.env.AI_WALKTHROUGH_URL || "https://api.leadconnectorhq.com/widget/bookings/walk-through-calendar-2",
  venuePhoto:
    process.env.AI_VENUE_PHOTO_URL || "https://assets.cdn.filesafe.space/3HmJCw40C6xzJYaLg6cK/media/6ae20b37d1d68437cf84940e.jpeg",
  partnerships: process.env.AI_PARTNERSHIP_URL || "https://sites.leadconnectorhq.com/preview/DD3E3pIVVr7o7QItcyHx"
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
  const b10 = MIN_VENUE_GUESTS * p.perGuestPrice;
  return `
TROPICA VENUE — APPROVED FACTS (only state what is here or what a tool returns)

Business
- Tropica Venue, ${CONTACT.address}. Phone ${CONTACT.phone} · Email ${CONTACT.email}. All dates/times are New York time (America/New_York).
- Suitable for birthday parties, baby showers, bridal showers, graduations, corporate events, networking events and private celebrations.

Capacity
- Up to ${SEATED_CAPACITY} seated guests or ${p.maxGuestCapacity} standing guests. Standard line: "Our venue accommodates up to ${SEATED_CAPACITY} seated guests or ${p.maxGuestCapacity} standing guests."
- 31–${p.maxGuestCapacity} guests: ask whether the event is seated or standing (only standing works).
- More than ${p.maxGuestCapacity} guests (LARGE EVENT): "Our Tropica space accommodates up to ${SEATED_CAPACITY} seated guests or ${p.maxGuestCapacity} standing guests. For a larger event, we can help explore partner venues that may accommodate your group." Collect details one at a time and hand off to the team (request_human_help). Never invent partner venue names, prices or availability. Never book it.

Venue rental pricing (private venue, whole space)
- $${p.perGuestPrice} per billable guest for the first ${INCLUDED_HOURS} hours. Minimum ${MIN_VENUE_GUESTS} billable guests = $${b10} minimum.
- Total rental ${MIN_DURATION}–${MAX_DURATION} hours. Each additional venue hour after the first ${INCLUDED_HOURS} is $${p.extraHourPrice} (max 7 extra hours = $${7 * p.extraHourPrice}). This is the VENUE hour rate — not DJ or photography.
- Formula: base = $${p.perGuestPrice} × max(guests, ${MIN_VENUE_GUESTS}); extra hours = total hours − ${INCLUDED_HOURS}; venue subtotal = base + extra hours × $${p.extraHourPrice}; plus any chosen add-ons with known prices.
- Examples: 15 guests/5h = $750 · 15 guests/6h = $875 · 15 guests/7h = $1,000 · 15 guests/12h = $1,625 · 10 or fewer/12h = $1,375 · 20 guests = $1,000 · 25 = $1,250 · 30 = $1,500 · 35 standing = $1,750 · 40 standing = $2,000 (all 5h).
- Minimum booking deposit: $${p.minDepositAmount}. It is PART of the amount due, not added on top, and not the full price. The remaining balance is due no later than 72 hours before the event.
- Pricing line when guests are unknown: "Our venue starts at $${p.perGuestPrice} per guest for five hours, with a ${MIN_VENUE_GUESTS}-guest minimum ($${b10}). The minimum booking deposit is $${p.minDepositAmount}. You can request up to ${MAX_DURATION} total hours, and each additional hour after the first five costs $${p.extraHourPrice}. How many guests are you expecting?"
- The 5-hour package includes two complimentary bottles of champagne, two TVs and one on-site helper.
- Start times: on the hour from 10 AM to 11 PM; the event must end by ${LATEST_END_LABEL}.
- Never quote the old $1,500 flat minimum. Never invent taxes, fees, refunds, payment deadlines or discounts. A quote is NOT a reservation and NOT proof the date is free.

Add-ons
- DJ: $${p.djPrice} for up to five hours. "Yes! DJ service is available for $${p.djPrice} for up to five hours."
- Photography: $${p.photographerBasePrice} for two hours with about 50 edited photos; extra photography hours $${p.photographerExtraHourPrice} each.
- Decorations are allowed and Tropica offers customized decor services — priced on request (team quotes it).
- Catering from our partner restaurants: Jamaican Jerk House (Jamaican / Caribbean), East Coast Street Tacos (Mexican), Cooklyn Eats (Southern soul food), or a custom mix — full menus via get_catering_menu. Priced separately; the team gives the quote. Never invent dishes or food prices.

Links (send only the one that matches what they want — no footer on every message)
- Book the venue / check event availability yourself: ${links.venue}
- Schedule a WALKTHROUGH (tour / in-person visit): ${EXTERNAL_LINKS.walkthrough}
- Table reservation: ${links.table} · Events & tickets: ${links.events} · Terms: ${links.terms}
- Venue photo (when they ask for pictures, say "Of course! Here's a look inside Tropica Venue! ✨" and share): ${EXTERNAL_LINKS.venuePhoto}
- Partnerships, sponsorships, vendor collaborations: ${EXTERNAL_LINKS.partnerships} (no venue booking for these).
- The walkthrough calendar and the venue booking are DIFFERENT things: a walkthrough never reserves the venue, and walkthrough slots say nothing about event availability.

Payments
- Card online, or Zelle (verified by the team). Never say a payment was received unless a tool says so.
- Cancellation: within 48 hours of booking = refunded per the terms; after that the deposit and any paid balance are non-refundable. Full terms: ${links.terms}

Not known (never guess — offer a team member): parking, outside food/cake policy, kids policy, dress code, custom or discounted pricing, decor prices. Catering prices are set by the team once the menu is final — explain that yourself (no hand-off needed).
${extra ? `\nExtra approved facts\n${extra}` : ""}`.trim();
};

import SystemSettings from "../models/SystemSettings";
import { getFrontendBaseUrl, normalizeBaseUrl } from "../utils/siteUrl";

/**
 * Approved business facts the AI may state. Prices are read live from SystemSettings (admin panel),
 * so changing a price in the admin panel changes what the AI quotes. Anything not listed here the AI
 * must not invent — it offers the website or a team member instead.
 *
 * Edit the STATIC_FACTS / FAQ below (or set AI_EXTRA_FACTS in .env) to teach the bot more.
 */

/** No guest minimum for private bookings — the venue is one flat price. */
export const MIN_VENUE_GUESTS = 1;
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

/** Venue capacity: 25 guests seated, up to 30 standing (the admin "max guest capacity" can only lower the total). */
export const SEATED_CAPACITY = 25;
export const STANDING_CAPACITY = 30;

/** Fixed links from the Tropica AI master prompt (override in .env if they ever change). */
export const EXTERNAL_LINKS = {
  walkthrough: process.env.AI_WALKTHROUGH_URL || "https://api.leadconnectorhq.com/widget/bookings/walk-through-calendar-2",
  /** Where the AI sends people who ask for photos, pictures or assets of the venue. */
  gallery: process.env.AI_GALLERY_URL || "https://www.tropica.nyc/gallery/",
  partnerships: process.env.AI_PARTNERSHIP_URL || "https://sites.leadconnectorhq.com/preview/DD3E3pIVVr7o7QItcyHx"
};

export interface Pricing {
  /** Flat price for the whole venue for the first 5 hours (does not depend on guests). */
  venueBasePrice: number;
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
    venueBasePrice: s.venueBasePrice ?? 800,
    // The admin setting, never above the room's 30 (standing) limit
    maxGuestCapacity: Math.min(s.maxGuestCapacity ?? STANDING_CAPACITY, STANDING_CAPACITY),
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
  const base = p.venueBasePrice;
  const money = (n: number) => `$${n.toLocaleString("en-US")}`;
  return `
TROPICA VENUE — APPROVED FACTS (only state what is here or what a tool returns)

Business
- Tropica Venue, ${CONTACT.address}. Phone ${CONTACT.phone} · Email ${CONTACT.email}. All dates/times are New York time (America/New_York).
- Suitable for birthday parties, baby showers, bridal showers, graduations, corporate events, networking events and private celebrations.

Capacity
- Up to ${Math.min(SEATED_CAPACITY, p.maxGuestCapacity)} guests seated, or up to ${p.maxGuestCapacity} guests standing (cocktail-style). Standard line: "Our venue accommodates up to ${Math.min(SEATED_CAPACITY, p.maxGuestCapacity)} guests seated or up to ${p.maxGuestCapacity} standing."
- There is NO guest minimum — any group size up to capacity can book, at the same flat price.
- More than ${p.maxGuestCapacity} guests (LARGE EVENT): "Our Tropica space accommodates up to ${p.maxGuestCapacity} guests. For a larger event, we can help explore partner venues that may accommodate your group." Collect details one at a time and hand off to the team (request_human_help). Never invent partner venue names, prices or availability. Never book it.

Venue rental pricing (private venue, whole space)
- FLAT PRICE: ${money(base)} for the whole venue for the first ${INCLUDED_HOURS} hours, for any group size up to ${p.maxGuestCapacity} guests (seated or standing). The price does NOT change with the number of guests — never quote a per-person or per-guest price.
- Total rental ${MIN_DURATION}–${MAX_DURATION} hours. Each additional venue hour after the first ${INCLUDED_HOURS} is $${p.extraHourPrice} (max 7 extra hours = ${money(7 * p.extraHourPrice)}). This is the VENUE hour rate — not DJ or photography.
- Formula: venue subtotal = ${money(base)} + (total hours − ${INCLUDED_HOURS}) × $${p.extraHourPrice}; plus any chosen add-ons with known prices.
- Examples (any guest count): 5h = ${money(base)} · 6h = ${money(base + p.extraHourPrice)} · 7h = ${money(base + 2 * p.extraHourPrice)} · 12h = ${money(base + 7 * p.extraHourPrice)}.
- Minimum booking deposit: $${p.minDepositAmount}. It is PART of the amount due, not added on top, and not the full price. The remaining balance is due no later than 72 hours before the event.
- Pricing line: "Our venue is ${money(base)} for five hours for your whole group (up to ${p.maxGuestCapacity} guests). The minimum booking deposit is $${p.minDepositAmount}. You can request up to ${MAX_DURATION} total hours, and each additional hour after the first five costs $${p.extraHourPrice}. How many guests are you expecting?"
- The 5-hour package includes two complimentary bottles of champagne, two TVs and one on-site helper.
- Start times: on the hour from 10 AM to 11 PM; the event must end by ${LATEST_END_LABEL}.
- Never quote the old $50-per-guest rate, the old $1,500 minimum or the old 10-guest minimum. Never invent taxes, fees, refunds, payment deadlines or discounts. A quote is NOT a reservation and NOT proof the date is free.

Add-ons
- DJ: $${p.djPrice} for up to five hours. "Yes! DJ service is available for $${p.djPrice} for up to five hours."
- Photography: $${p.photographerBasePrice} for two hours with about 50 edited photos; extra photography hours $${p.photographerExtraHourPrice} each.
- Decorations are allowed and Tropica offers customized decor services — priced on request (team quotes it).
- Catering from our partner restaurants: Jamaican Jerk House (Jamaican / Caribbean), East Coast Street Tacos (Mexican), Cooklyn Eats (Southern soul food), or a custom mix — full menus via get_catering_menu. Priced separately; the team gives the quote. Never invent dishes or food prices.

Links (send only the one that matches what they want — no footer on every message)
- Book the venue / check event availability yourself: ${links.venue}
- Schedule a WALKTHROUGH (tour / in-person visit): ${EXTERNAL_LINKS.walkthrough}
- Table reservation: ${links.table} · Events & tickets: ${links.events} · Terms: ${links.terms}
- Photos / pictures / assets / "what does it look like": always send the Tropica gallery link — say "Of course! Here's a look inside Tropica Venue! ✨" and share ${EXTERNAL_LINKS.gallery} . Never send a single image file or any other photo link.
- Partnerships, sponsorships, vendor collaborations: ${EXTERNAL_LINKS.partnerships} (no venue booking for these).
- The walkthrough calendar and the venue booking are DIFFERENT things: a walkthrough never reserves the venue, and walkthrough slots say nothing about event availability.

Payments
- Card online, or Zelle (verified by the team). Never say a payment was received unless a tool says so.
- Cancellation: within 48 hours of booking = refunded per the terms; after that the deposit and any paid balance are non-refundable. Full terms: ${links.terms}

Not known (never guess — offer a team member): parking, outside food/cake policy, kids policy, dress code, custom or discounted pricing, decor prices. Catering prices are set by the team once the menu is final — explain that yourself (no hand-off needed).
${extra ? `\nExtra approved facts\n${extra}` : ""}`.trim();
};

import crypto from "crypto";
import { Types } from "mongoose";
import Booking from "../models/Booking";
import MarketplaceBooking from "../models/MarketplaceBooking";
import PartnerVenue from "../models/PartnerVenue";

/**
 * A "party" is anything a host can invite guests to: a private event at Tropica (Booking)
 * or a paid booking at a partner venue (MarketplaceBooking). The guest-pass / celebration
 * code works on this common shape so both kinds behave the same way.
 */
export interface Party {
  kind: "tropica" | "marketplace";
  model: "Booking" | "MarketplaceBooking";
  doc: any;
  _id: Types.ObjectId;
  user: Types.ObjectId;
  capacity: number;
  customerName: string;
  occasion: string;
  eventTitle: string;
  flyerUrl: string;
  /** UTC-midnight Date of the event day (same convention as Booking.bookingDate). */
  date: Date;
  startTime: string; // HH:MM
  endTime: string; // h:mm AM/PM
  durationHours: number;
  venueName: string;
  venueAddress: string;
  invitable: boolean;
  cancelled: boolean;
  requireHostApproval: boolean;
  invitationToken?: string;
}

const TROPICA_VENUE_NAME = "Tropica Sanctuary NYC";
const TROPICA_VENUE_ADDRESS = process.env.TROPICA_ADDRESS || "Brooklyn, NY";

export const MARKETPLACE_INVITABLE = ["deposit_paid", "paid", "completed"];

const to12h = (hhmm: string) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h)) return "";
  const hh = ((h % 24) + 24) % 24;
  return `${hh % 12 || 12}:${String(m || 0).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
};

/** Invites only work for live, paid (or Zelle-proof-submitted) private bookings at Tropica. */
const tropicaInvitable = (b: any): boolean =>
  !!b &&
  b.bookingType === "private_event" &&
  b.status !== "cancelled" &&
  (b.status === "confirmed" ||
    ["deposit_paid", "paid"].includes(b.paymentStatus) ||
    (b.paymentMethod === "zelle" && !!b.zelleProofUrl));

export const partyFromTropica = (b: any): Party => ({
  kind: "tropica",
  model: "Booking",
  doc: b,
  _id: b._id,
  user: b.user?._id || b.user,
  capacity: b.partySize || 0,
  customerName: b.customerName || "",
  occasion: b.occasion || "celebration",
  eventTitle: b.eventTitle || "",
  flyerUrl: b.flyerUrl || "",
  date: b.bookingDate,
  startTime: b.bookingTime,
  endTime: b.eventEndTime || "",
  durationHours: b.durationHours,
  venueName: TROPICA_VENUE_NAME,
  venueAddress: TROPICA_VENUE_ADDRESS,
  invitable: tropicaInvitable(b),
  cancelled: b.status === "cancelled",
  requireHostApproval: Boolean(b.requireHostApproval),
  invitationToken: b.invitationToken
});

export const partyFromMarketplace = (m: any, venue?: any): Party => {
  const v = venue || (m.venue && typeof m.venue === "object" && m.venue.name ? m.venue : null);
  return {
    kind: "marketplace",
    model: "MarketplaceBooking",
    doc: m,
    _id: m._id,
    user: m.user?._id || m.user,
    capacity: m.guests || 0,
    customerName: m.customerName || "",
    occasion: m.occasion || "celebration",
    eventTitle: m.eventTitle || "",
    flyerUrl: m.flyerUrl || v?.flyerUrl || "",
    date: new Date(`${m.date}T00:00:00.000Z`),
    startTime: m.startTime,
    endTime: to12h(m.endTime),
    durationHours: m.durationHours,
    venueName: v?.name || m.venueName,
    venueAddress: v?.address || "",
    invitable: MARKETPLACE_INVITABLE.includes(m.status),
    cancelled: ["cancelled", "declined", "expired"].includes(m.status),
    requireHostApproval: Boolean(m.requireHostApproval),
    invitationToken: m.invitationToken
  };
};

const VENUE_FIELDS = "name address flyerUrl";

export const findPartyByToken = async (token: string): Promise<Party | null> => {
  if (!token) return null;
  const b = await Booking.findOne({ invitationToken: token });
  if (b) return partyFromTropica(b);
  const m = await MarketplaceBooking.findOne({ invitationToken: token }).populate("venue", VENUE_FIELDS);
  return m ? partyFromMarketplace(m) : null;
};

export const findPartyById = async (id: string): Promise<Party | null> => {
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const b = await Booking.findById(id);
  if (b) return b.bookingType === "private_event" ? partyFromTropica(b) : null;
  const m = await MarketplaceBooking.findById(id).populate("venue", VENUE_FIELDS);
  return m ? partyFromMarketplace(m) : null;
};

/** The party a (booking-populated) guest pass belongs to. */
export const partyForPass = async (pass: any): Promise<Party | null> => {
  const b = pass?.booking;
  if (!b || typeof b !== "object" || !b._id) return null;
  if (pass.bookingModel !== "MarketplaceBooking") return partyFromTropica(b);
  const venue = b.venue && typeof b.venue === "object" && b.venue.name ? b.venue : await PartnerVenue.findById(b.venue).select(VENUE_FIELDS).lean();
  return partyFromMarketplace(b, venue);
};

/** Make sure the party has an invite token (Tropica bookings get one at creation; partner ones when paid). */
export const ensureInvitationToken = async (party: Party): Promise<string> => {
  if (party.invitationToken) return party.invitationToken;
  const token = crypto.randomBytes(16).toString("hex");
  const Model: any = party.model === "Booking" ? Booking : MarketplaceBooking;
  const updated = await Model.findOneAndUpdate(
    { _id: party._id, $or: [{ invitationToken: { $exists: false } }, { invitationToken: null }] },
    { $set: { invitationToken: token } },
    { new: true }
  )
    .select("invitationToken")
    .lean();
  const final = updated?.invitationToken || (await Model.findById(party._id).select("invitationToken").lean())?.invitationToken || token;
  party.invitationToken = final;
  if (party.doc) party.doc.invitationToken = final;
  return final;
};

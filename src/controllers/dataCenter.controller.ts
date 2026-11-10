import { NextFunction, Request, Response } from "express";
import User from "../models/User";
import Booking from "../models/Booking";
import TicketOrder from "../models/TicketOrder";
import Ticket from "../models/Ticket";
import GuestPass from "../models/GuestPass";
import "../models/Event"; // registers the Event model used by populate("event")
import logger from "../config/logger";

/**
 * Data Center: one marketing contact per person, merged from accounts, venue/table bookings,
 * event ticket orders and party guest passes. Matched by phone (last 10 digits), then email.
 */

type Source = "venue_host" | "table_guest" | "event_buyer" | "party_guest" | "promoter" | "account";

interface Activity {
  type: "venue_booking" | "table_booking" | "event_ticket" | "party_guest" | "signup";
  title: string;
  date: string; // when it happened / event date
  eventDate?: string;
  amount?: number;
  status?: string;
  attended?: boolean;
}

interface Contact {
  key: string;
  name: string;
  email: string;
  phone: string;
  sources: Source[];
  hasAccount: boolean;
  accountCreatedAt?: string;
  firstSeen: string;
  lastActivityAt: string;
  lastActivity: string;
  lastEvent?: { title: string; date: string; type: Activity["type"] };
  nextEvent?: { title: string; date: string; type: Activity["type"] };
  venueBookings: number;
  tableBookings: number;
  eventOrders: number;
  ticketsBought: number;
  partiesJoined: number;
  checkIns: number;
  totalSpent: number;
  guestOf: string[];
  marketingConsent: boolean;
  utmSource?: string;
  utmCampaign?: string;
  activities: Activity[];
}

const PLACEHOLDER_EMAIL = /^guest_|@tropica\.nyc$|@fishndrop\.com$/i;
const cleanEmail = (e?: string) => {
  const v = (e || "").trim().toLowerCase();
  return v && !PLACEHOLDER_EMAIL.test(v) ? v : "";
};
const phoneKey = (p?: string) => {
  const d = (p || "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : "";
};
const realName = (n?: string) => {
  const v = (n || "").trim();
  return v && v !== "Guest User" ? v : "";
};
const iso = (d?: any) => (d ? new Date(d).toISOString() : "");
const firstName = (n?: string) => (n || "").trim().split(/\s+/)[0] || "a host";
const nice = (s?: string) => (s || "").replace(/_/g, " ");

const SOURCE_LABEL: Record<Source, string> = {
  venue_host: "Venue host",
  table_guest: "Table booking",
  event_buyer: "Event ticket buyer",
  party_guest: "Party guest",
  promoter: "Promoter",
  account: "Account only"
};

/** Builds every contact. Kept in memory: fine for tens of thousands of records. */
const buildContacts = async (): Promise<Contact[]> => {
  const [users, bookings, orders, ticketAgg, passes] = await Promise.all([
    User.find({ role: { $in: ["user", "promoter"] } })
      .select("name email phone role createdAt companyName")
      .lean(),
    Booking.find({})
      .select(
        "user customerName customerEmail customerPhone bookingType occasion bookingDate bookingTime partySize status paymentStatus totalAmount remainingAmount createdAt marketingConsent utmSource utmCampaign"
      )
      .lean(),
    TicketOrder.find({ status: "paid" })
      .select("user customerName customerEmail customerPhone event items totalAmount paidAt createdAt")
      .populate("event", "title date")
      .lean(),
    Ticket.aggregate([{ $group: { _id: "$order", checkedIn: { $sum: { $cond: ["$checkedIn", 1, 0] } } } }]),
    GuestPass.find({ status: { $ne: "rejected" } })
      .select("user guestName guestPhone guestEmail booking checkedIn checkedInAt createdAt status")
      .populate("booking", "customerName occasion bookingDate status")
      .lean()
  ]);

  const checkInsByOrder = new Map(ticketAgg.map((t: any) => [String(t._id), t.checkedIn as number]));
  const byKey = new Map<string, Contact>();
  const keyByUser = new Map<string, string>();
  const keyByEmail = new Map<string, string>();

  /** Find or create the contact for this identity; links phone, email and account id together. */
  const touch = (o: { userId?: any; name?: string; email?: string; phone?: string; at?: any }): Contact => {
    const pk = phoneKey(o.phone);
    const em = cleanEmail(o.email);
    const uid = o.userId ? String(o.userId) : "";
    const key =
      (pk && byKey.has(`p:${pk}`) && `p:${pk}`) ||
      (uid && keyByUser.get(uid)) ||
      (em && keyByEmail.get(em)) ||
      (pk ? `p:${pk}` : em ? `e:${em}` : uid ? `u:${uid}` : `x:${Math.random()}`);

    let c = byKey.get(key);
    if (!c) {
      c = {
        key,
        name: "",
        email: "",
        phone: "",
        sources: [],
        hasAccount: false,
        firstSeen: iso(o.at) || new Date().toISOString(),
        lastActivityAt: "",
        lastActivity: "",
        venueBookings: 0,
        tableBookings: 0,
        eventOrders: 0,
        ticketsBought: 0,
        partiesJoined: 0,
        checkIns: 0,
        totalSpent: 0,
        guestOf: [],
        marketingConsent: false,
        activities: []
      };
      byKey.set(key, c);
    }
    const nm = realName(o.name);
    if (nm && (!c.name || nm.length > c.name.length)) c.name = nm;
    if (em && !c.email) c.email = em;
    if (o.phone && !c.phone && pk) c.phone = o.phone;
    if (uid) keyByUser.set(uid, key);
    if (em) keyByEmail.set(em, key);
    const at = iso(o.at);
    if (at && at < c.firstSeen) c.firstSeen = at;
    return c;
  };

  const addSource = (c: Contact, s: Source) => {
    if (!c.sources.includes(s)) c.sources.push(s);
  };
  const addActivity = (c: Contact, a: Activity) => {
    c.activities.push(a);
    if (!c.lastActivityAt || a.date > c.lastActivityAt) {
      c.lastActivityAt = a.date;
      c.lastActivity = a.title;
    }
  };

  // Accounts
  for (const u of users as any[]) {
    const c = touch({ userId: u._id, name: u.name, email: u.email, phone: u.phone, at: u.createdAt });
    c.hasAccount = true;
    c.accountCreatedAt = iso(u.createdAt);
    if (u.role === "promoter") addSource(c, "promoter");
    addActivity(c, { type: "signup", title: u.role === "promoter" ? "Registered as promoter" : "Created account", date: iso(u.createdAt) });
  }

  // Venue & table bookings
  for (const b of bookings as any[]) {
    const c = touch({ userId: b.user, name: b.customerName, email: b.customerEmail, phone: b.customerPhone, at: b.createdAt });
    const isVenue = b.bookingType === "private_event";
    const paidAmount = b.status !== "cancelled" && b.paymentStatus !== "pending_payment" ? Math.max(0, (b.totalAmount || 0) - (b.remainingAmount || 0)) : 0;
    addSource(c, isVenue ? "venue_host" : "table_guest");
    if (isVenue) c.venueBookings += 1;
    else c.tableBookings += 1;
    c.totalSpent += paidAmount;
    if (b.marketingConsent) c.marketingConsent = true;
    if (!c.utmSource && b.utmSource) {
      c.utmSource = b.utmSource;
      c.utmCampaign = b.utmCampaign;
    }
    addActivity(c, {
      type: isVenue ? "venue_booking" : "table_booking",
      title: isVenue ? `Venue booking: ${nice(b.occasion) || "celebration"} (${b.partySize} guests)` : `Table booking (${b.partySize} guests)`,
      date: iso(b.createdAt),
      eventDate: iso(b.bookingDate),
      amount: paidAmount,
      status: b.status
    });
  }

  // Event ticket orders (paid)
  for (const o of orders as any[]) {
    const c = touch({ userId: o.user, name: o.customerName, email: o.customerEmail, phone: o.customerPhone, at: o.paidAt || o.createdAt });
    const qty = (o.items || []).reduce((s: number, i: any) => s + (i.quantity || 0), 0);
    const inCount = checkInsByOrder.get(String(o._id)) || 0;
    addSource(c, "event_buyer");
    c.eventOrders += 1;
    c.ticketsBought += qty;
    c.checkIns += inCount;
    c.totalSpent += o.totalAmount || 0;
    addActivity(c, {
      type: "event_ticket",
      title: `${qty} ticket${qty === 1 ? "" : "s"}: ${o.event?.title || "Event"}`,
      date: iso(o.paidAt || o.createdAt),
      eventDate: iso(o.event?.date),
      amount: o.totalAmount || 0,
      status: "paid",
      attended: inCount > 0
    });
  }

  // Party guests (joined someone's venue booking)
  for (const p of passes as any[]) {
    if (!p.booking || p.booking.status === "cancelled") continue;
    const c = touch({ userId: p.user, name: p.guestName, email: p.guestEmail, phone: p.guestPhone, at: p.createdAt });
    const host = firstName(p.booking.customerName);
    addSource(c, "party_guest");
    c.partiesJoined += 1;
    if (p.checkedIn) c.checkIns += 1;
    if (!c.guestOf.includes(host)) c.guestOf.push(host);
    addActivity(c, {
      type: "party_guest",
      title: `Guest at ${host}'s ${nice(p.booking.occasion) || "party"}`,
      date: iso(p.createdAt),
      eventDate: iso(p.booking.bookingDate),
      status: p.status,
      attended: !!p.checkedIn
    });
  }

  // Last / next event + tidy up
  const nowIso = new Date(new Date().toISOString().slice(0, 10)).toISOString();
  const contacts = [...byKey.values()].filter((c) => c.phone || c.email);
  for (const c of contacts) {
    const withEvent = c.activities.filter((a) => a.eventDate);
    const past = withEvent.filter((a) => a.eventDate! < nowIso).sort((a, b) => b.eventDate!.localeCompare(a.eventDate!));
    const future = withEvent.filter((a) => a.eventDate! >= nowIso).sort((a, b) => a.eventDate!.localeCompare(b.eventDate!));
    if (past[0]) c.lastEvent = { title: past[0].title, date: past[0].eventDate!, type: past[0].type };
    if (future[0]) c.nextEvent = { title: future[0].title, date: future[0].eventDate!, type: future[0].type };
    if (c.sources.length === 0) c.sources.push("account");
    c.totalSpent = Math.round(c.totalSpent * 100) / 100;
    c.activities.sort((a, b) => b.date.localeCompare(a.date));
  }
  return contacts;
};

const applyFilters = (all: Contact[], q: string, source: string, sort: string, consentOnly: boolean) => {
  const needle = q.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  let list = all.filter((c) => {
    if (source && source !== "all" && !c.sources.includes(source as Source)) return false;
    if (consentOnly && !c.marketingConsent) return false;
    if (!needle) return true;
    return (
      c.name.toLowerCase().includes(needle) ||
      c.email.includes(needle) ||
      (digits.length >= 3 && c.phone.replace(/\D/g, "").includes(digits)) ||
      c.guestOf.some((h) => h.toLowerCase().includes(needle))
    );
  });
  const by: Record<string, (a: Contact, b: Contact) => number> = {
    recent: (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
    spent: (a, b) => b.totalSpent - a.totalSpent,
    name: (a, b) => (a.name || "~").localeCompare(b.name || "~"),
    newest: (a, b) => b.firstSeen.localeCompare(a.firstSeen),
    visits: (a, b) => b.checkIns + b.venueBookings + b.tableBookings - (a.checkIns + a.venueBookings + a.tableBookings)
  };
  list = list.sort(by[sort] || by.recent);
  return list;
};

const readQuery = (req: Request) => ({
  q: String(req.query.q || "").slice(0, 100),
  source: String(req.query.source || "all"),
  sort: String(req.query.sort || "recent"),
  consentOnly: req.query.consent === "1"
});

/** GET /api/admin/data-center?q=&source=&sort=&consent=1&page=&limit= */
export const getDataCenter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { q, source, sort, consentOnly } = readQuery(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));

    const all = await buildContacts();
    const filtered = applyFilters(all, q, source, sort, consentOnly);
    const count = (s: Source) => all.filter((c) => c.sources.includes(s)).length;

    res.status(200).json({
      success: true,
      summary: {
        total: all.length,
        withEmail: all.filter((c) => c.email).length,
        withPhone: all.filter((c) => c.phone).length,
        venueHosts: count("venue_host"),
        tableGuests: count("table_guest"),
        eventBuyers: count("event_buyer"),
        partyGuests: count("party_guest"),
        promoters: count("promoter"),
        consented: all.filter((c) => c.marketingConsent).length,
        totalRevenue: Math.round(all.reduce((s, c) => s + c.totalSpent, 0) * 100) / 100
      },
      total: filtered.length,
      page,
      pages: Math.max(1, Math.ceil(filtered.length / limit)),
      contacts: filtered.slice((page - 1) * limit, page * limit)
    });
  } catch (error: any) {
    logger.error("Data center failed", { error: error.message });
    next(new Error(`Failed to load data center: ${error.message}`));
  }
};

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  // Neutralize spreadsheet formulas and quote everything
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** GET /api/admin/data-center/export: CSV of the current filter (all pages). */
export const exportDataCenter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { q, source, sort, consentOnly } = readQuery(req);
    const list = applyFilters(await buildContacts(), q, source, sort, consentOnly);
    const header = [
      "Name", "Email", "Phone", "Tags", "Has account", "First seen", "Last activity date", "Last activity",
      "Last event", "Last event date", "Next event", "Next event date", "Venue bookings", "Table bookings",
      "Event orders", "Tickets bought", "Parties joined", "Guest of", "Check-ins", "Total spent (USD)",
      "Marketing consent", "UTM source", "UTM campaign"
    ];
    const rows = list.map((c) =>
      [
        c.name, c.email, c.phone, c.sources.map((s) => SOURCE_LABEL[s]).join("; "), c.hasAccount ? "Yes" : "No",
        c.firstSeen.slice(0, 10), c.lastActivityAt.slice(0, 10), c.lastActivity,
        c.lastEvent?.title, c.lastEvent?.date.slice(0, 10), c.nextEvent?.title, c.nextEvent?.date.slice(0, 10),
        c.venueBookings, c.tableBookings, c.eventOrders, c.ticketsBought, c.partiesJoined, c.guestOf.join("; "),
        c.checkIns, c.totalSpent.toFixed(2), c.marketingConsent ? "Yes" : "No", c.utmSource, c.utmCampaign
      ].map(csvCell).join(",")
    );
    const csv = "﻿" + [header.map(csvCell).join(","), ...rows].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tropica-contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    logger.info(`[Data Center] ${req.user?.name || "admin"} exported ${list.length} contacts (source=${source}, consent=${consentOnly})`);
    res.status(200).send(csv);
  } catch (error: any) {
    next(new Error(`Failed to export contacts: ${error.message}`));
  }
};

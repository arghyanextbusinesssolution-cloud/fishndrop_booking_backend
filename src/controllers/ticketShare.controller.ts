import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import Ticket, { ITicket, generateQrCodeToken } from "../models/Ticket";
import TicketOrder, { ITicketOrder } from "../models/TicketOrder";
import User from "../models/User";
import { sendGHLTicketGuestEvent, TicketGuestAction, TicketGuestInfo } from "../integrations/ghl";
import { getEventStartAt } from "../utils/eventTime.utils";
import { issueLiveQr } from "../utils/liveQr.utils";
import logger from "../config/logger";

/**
 * Guest sharing for multi-ticket event orders.
 *
 *  Buyer pays for N tickets → seat #1 is the buyer's, seats #2..N are "unassigned".
 *  Buyer shares ONE link → a guest verifies their phone (OTP), enters their name → seat is "pending".
 *  Buyer accepts (seat "accepted", in the guest's name) or rejects (seat back to "unassigned").
 *  An accepted guest may give the seat back until 48h after purchase; the buyer is notified.
 *  Only the holder of an accepted seat can open its rotating door QR.
 */

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SHARE_TOKEN = /^shr_[a-f0-9]{36}$/;
const E164 = /^\+\d{8,15}$/;
/** Guests can still claim / be assigned seats until 12h after the event starts. */
const CLAIM_GRACE_MS = 12 * 60 * 60 * 1000;

const firstName = (n?: string) => (n || "").trim().split(/\s+/)[0] || "Your friend";
const realName = (n?: string) => (n && n !== "Guest User" ? n : "");
const realEmail = (e?: string) => (e && !/^guest_/.test(e) ? e : "");

const EVENT_FIELDS = "title slug date startTime endTime venueName venueAddress venueType venueLat venueLng flyerUrl status";

/** Optional auth: who is viewing (no 401 for anonymous visitors). */
const optionalUserId = (req: Request): string | null => {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  try {
    const decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET as string) as any;
    return decoded?.id ? String(decoded.id) : null;
  } catch {
    return null;
  }
};

type Me = { _id: any; name?: string; email?: string; phone?: string; isPhoneVerified?: boolean; role?: string };

const loadMe = async (userId: string | null | undefined): Promise<Me | null> =>
  userId ? ((await User.findById(userId).select("name email phone isPhoneVerified role").lean()) as Me | null) : null;

const verifiedPhone = (me: Me | null): string => (me?.isPhoneVerified && me.phone ? me.phone : "");

export const isOrderBuyer = (order: Pick<ITicketOrder, "user" | "customerPhone">, me: Me | null): boolean =>
  !!me &&
  (String(order.user || "") === String(me._id) || (!!verifiedPhone(me) && verifiedPhone(me) === order.customerPhone));

/** True when `me` is the person who enters with this ticket. Legacy tickets belong to the buyer. */
export const isTicketHolder = (t: ITicket | any, me: Me | null): boolean => {
  if (!me) return false;
  const phone = verifiedPhone(me);
  if (!t.holderStatus) {
    return String(t.user || "") === String(me._id) || (!!phone && phone === t.customerPhone);
  }
  return String(t.holderUser || "") === String(me._id) || (!!phone && phone === t.holderPhone);
};

const isClaimWindowOpen = (event: any, now = Date.now()): boolean => {
  if (!event || event.status === "cancelled" || event.status === "rejected") return false;
  const start = getEventStartAt(event);
  return !start || now < start.getTime() + CLAIM_GRACE_MS;
};

const seatStats = async (orderId: any) => {
  const seats = await Ticket.find({ order: orderId, isBuyerSeat: { $ne: true }, status: { $in: ["valid", "used"] } })
    .select("holderStatus")
    .lean();
  return {
    seatsTotal: seats.length,
    seatsOpen: seats.filter((s) => s.holderStatus === "unassigned").length,
    seatsPending: seats.filter((s) => s.holderStatus === "pending").length,
    seatsAccepted: seats.filter((s) => s.holderStatus === "accepted").length
  };
};

const notify = async (action: TicketGuestAction, order: any, ticket: any, guest: TicketGuestInfo): Promise<void> => {
  try {
    const event = order.event?.title ? order.event : (await TicketOrder.findById(order._id).populate("event", EVENT_FIELDS))?.event;
    await sendGHLTicketGuestEvent(action, order, event, ticket, guest, await seatStats(order._id));
  } catch (err: any) {
    logger.error(`[GHL] ticket_guest_${action} failed`, { error: err?.message });
  }
};

/** Fields cleared when a seat goes back to the buyer. */
const UNASSIGN = {
  $set: { holderStatus: "unassigned" },
  $unset: { holderUser: 1, holderName: 1, holderPhone: 1, holderEmail: 1, requestedAt: 1, acceptedAt: 1 }
};

/** Seat view for the buyer's guest list. */
export const seatForBuyer = (t: any) => ({
  _id: t._id,
  ticketCode: t.ticketCode,
  tierName: t.tierName,
  isBuyerSeat: !!t.isBuyerSeat,
  holderStatus: t.holderStatus || "accepted",
  holderName: t.holderName || (t.isBuyerSeat ? t.customerName : ""),
  holderPhone: t.holderPhone || "",
  requestedAt: t.requestedAt,
  acceptedAt: t.acceptedAt,
  checkedIn: t.checkedIn,
  checkedInAt: t.checkedInAt,
  status: t.status
});

/* ─────────────────────────────── Public share link ─────────────────────────────── */

/**
 * GET /api/tickets/share/:token
 * Invite preview. With a login token it also returns the viewer's own seat (if any).
 */
export const getShareInvite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = sanitizeString(req.params.token);
    if (!SHARE_TOKEN.test(token)) {
      res.status(404).json({ success: false, message: "Invite link not found" });
      return;
    }
    const order = await TicketOrder.findOne({ shareToken: token, status: "paid" }).populate("event", EVENT_FIELDS);
    if (!order) {
      res.status(404).json({ success: false, message: "This invite link is no longer valid" });
      return;
    }

    const me = await loadMe(optionalUserId(req));
    const isBuyer = isOrderBuyer(order, me);
    const phone = verifiedPhone(me);
    const mySeat = me
      ? await Ticket.findOne({
          order: order._id,
          isBuyerSeat: { $ne: true },
          holderStatus: { $in: ["pending", "accepted"] },
          $or: [{ holderUser: me._id }, ...(phone ? [{ holderPhone: phone }] : [])]
        }).lean()
      : null;
    const stats = await seatStats(order._id);
    const event: any = order.event;

    res.status(200).json({
      success: true,
      invite: {
        buyerName: firstName(order.customerName),
        event,
        ...stats,
        claimOpen: isClaimWindowOpen(event),
        isBuyer,
        wasRejected: !!phone && (order.rejectedPhones || []).includes(phone),
        guestCancelDeadline: order.guestCancelDeadline,
        mySeat: mySeat
          ? {
              _id: mySeat._id,
              ticketCode: mySeat.ticketCode,
              tierName: mySeat.tierName,
              holderStatus: mySeat.holderStatus,
              holderName: mySeat.holderName,
              qrCodeToken: mySeat.holderStatus === "accepted" ? mySeat.qrCodeToken : undefined,
              checkedIn: mySeat.checkedIn
            }
          : null
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to load invite: ${error.message}`));
  }
};

/**
 * POST /api/tickets/share/:token/claim   { name }   (requires phone-OTP login)
 * Guest requests one of the buyer's open seats. The buyer then accepts or rejects.
 */
export const claimSharedSeat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, code: "LOGIN_REQUIRED", message: "Please verify your phone number first" });
      return;
    }
    const token = sanitizeString(req.params.token);
    const nameInput = sanitizeString(req.body.name).slice(0, 100);

    const order = SHARE_TOKEN.test(token)
      ? await TicketOrder.findOne({ shareToken: token, status: "paid" }).populate("event", EVENT_FIELDS)
      : null;
    if (!order) {
      res.status(404).json({ success: false, message: "This invite link is no longer valid" });
      return;
    }
    if (!isClaimWindowOpen(order.event)) {
      res.status(410).json({ success: false, code: "CLAIM_CLOSED", message: "This event has ended or was cancelled." });
      return;
    }

    const guest = await User.findById(req.user._id);
    if (!guest || !guest.phone || !guest.isPhoneVerified) {
      res.status(403).json({ success: false, code: "PHONE_VERIFICATION_REQUIRED", message: "Please verify your phone number first" });
      return;
    }
    if (isOrderBuyer(order, guest as any)) {
      res.status(400).json({ success: false, code: "IS_BUYER", message: "You bought these tickets. Share this link with your friends." });
      return;
    }
    if ((order.rejectedPhones || []).includes(guest.phone)) {
      res.status(403).json({ success: false, code: "REJECTED", message: `${firstName(order.customerName)} declined your request for this event.` });
      return;
    }

    const guestName = nameInput || realName(guest.name);
    if (!guestName || guestName.length < 2) {
      res.status(400).json({ success: false, code: "NAME_REQUIRED", message: "Please enter your full name" });
      return;
    }
    if (nameInput && nameInput !== guest.name && (!realName(guest.name) || guest.role === "user")) {
      guest.name = nameInput;
      await guest.save();
    }

    const existing = await Ticket.findOne({
      order: order._id,
      holderStatus: { $in: ["pending", "accepted"] },
      $or: [{ holderUser: guest._id }, { holderPhone: guest.phone }]
    });
    if (existing) {
      if (!existing.holderUser) {
        existing.holderUser = guest._id as any;
        await existing.save();
      }
      res.status(200).json({ success: true, alreadyClaimed: true, holderStatus: existing.holderStatus, message: "You already have a seat request on this order." });
      return;
    }

    // Atomic: take exactly one open seat, so two guests can never get the same one.
    const seat = await Ticket.findOneAndUpdate(
      { order: order._id, isBuyerSeat: { $ne: true }, holderStatus: "unassigned", status: "valid" },
      {
        $set: {
          holderStatus: "pending",
          holderUser: guest._id,
          holderName: guestName,
          holderPhone: guest.phone,
          holderEmail: realEmail(guest.email),
          requestedAt: new Date()
        }
      },
      { returnDocument: "after", sort: { createdAt: 1 } }
    );
    if (!seat) {
      res.status(409).json({ success: false, code: "NO_SEATS", message: `All of ${firstName(order.customerName)}'s tickets have been claimed.` });
      return;
    }

    logger.info(`Guest ${guestName} requested seat ${seat.ticketCode} on order ${order.orderNumber}`);
    void notify("requested", order, seat, { name: guestName, phone: guest.phone, email: realEmail(guest.email) });

    res.status(201).json({
      success: true,
      holderStatus: "pending",
      message: `Request sent! ${firstName(order.customerName)} will accept you soon and your ticket will appear in My Tickets.`
    });
  } catch (error: any) {
    next(new Error(`Failed to request a seat: ${error.message}`));
  }
};

/* ─────────────────────────────── Buyer actions ─────────────────────────────── */

const loadSeatForBuyer = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Please sign in" });
    return null;
  }
  const ticketId = sanitizeString(req.params.ticketId);
  if (!OBJECT_ID.test(ticketId)) {
    res.status(400).json({ success: false, message: "Invalid ticket" });
    return null;
  }
  const seat = await Ticket.findById(ticketId);
  const order = seat ? await TicketOrder.findById(seat.order).populate("event", EVENT_FIELDS) : null;
  if (!seat || !order || order.status !== "paid" || seat.isBuyerSeat || !seat.holderStatus) {
    res.status(404).json({ success: false, message: "Seat not found" });
    return null;
  }
  const me = await loadMe(String(req.user._id));
  if (!isOrderBuyer(order, me)) {
    res.status(403).json({ success: false, message: "Only the ticket buyer can manage these seats" });
    return null;
  }
  if (!["valid"].includes(seat.status) || seat.checkedIn) {
    res.status(409).json({ success: false, message: "This ticket was already used or is no longer valid" });
    return null;
  }
  return { seat, order };
};

/**
 * PATCH /api/tickets/seats/:ticketId/holder   { action: "accept" | "reject" }
 * Buyer approves or declines a guest's pending request.
 */
export const decideSeatRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const action = req.body.action === "accept" ? "accept" : req.body.action === "reject" ? "reject" : null;
    if (!action) {
      res.status(400).json({ success: false, message: "action must be accept or reject" });
      return;
    }
    const loaded = await loadSeatForBuyer(req, res);
    if (!loaded) return;
    const { seat, order } = loaded;

    const guest: TicketGuestInfo = { name: seat.holderName || "Guest", phone: seat.holderPhone || "", email: seat.holderEmail };
    const update =
      action === "accept"
        ? { $set: { holderStatus: "accepted", acceptedAt: new Date(), qrCodeToken: generateQrCodeToken() } }
        : { ...UNASSIGN, $set: { ...UNASSIGN.$set, qrCodeToken: generateQrCodeToken() } };

    // Only act on a still-pending request (guest may have withdrawn in the meantime)
    const updated = await Ticket.findOneAndUpdate({ _id: seat._id, holderStatus: "pending" }, update, { returnDocument: "after" });
    if (!updated) {
      res.status(409).json({ success: false, message: "This request is no longer pending" });
      return;
    }
    if (action === "reject" && guest.phone) {
      await TicketOrder.updateOne({ _id: order._id }, { $addToSet: { rejectedPhones: guest.phone } });
    }

    logger.info(`Buyer ${action}ed ${guest.name} for seat ${seat.ticketCode} (${order.orderNumber})`);
    void notify(action === "accept" ? "accepted" : "rejected", order, updated, guest);

    res.status(200).json({ success: true, seat: seatForBuyer(updated) });
  } catch (error: any) {
    next(new Error(`Failed to update guest: ${error.message}`));
  }
};

/**
 * POST /api/tickets/seats/:ticketId/assign   { name, phone }   (phone in +E.164)
 * Buyer gives an open seat directly to someone (auto-accepted). That person signs in
 * with this phone number to see the ticket and its live QR.
 */
export const assignSeat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = sanitizeString(req.body.name).slice(0, 100);
    const phone = sanitizeString(req.body.phone).replace(/[^\d+]/g, "");
    if (name.length < 2 || !E164.test(phone)) {
      res.status(400).json({ success: false, message: "Enter the guest's full name and mobile number" });
      return;
    }
    const loaded = await loadSeatForBuyer(req, res);
    if (!loaded) return;
    const { seat, order } = loaded;
    if (phone === order.customerPhone) {
      res.status(400).json({ success: false, message: "That's your own number. You already have your ticket." });
      return;
    }
    const taken = await Ticket.exists({ order: order._id, holderPhone: phone, holderStatus: { $in: ["pending", "accepted"] } });
    if (taken) {
      res.status(409).json({ success: false, message: "This person already has a seat on this order" });
      return;
    }
    const user = await User.findOne({ phone }).select("_id email").lean();
    const now = new Date();
    const updated = await Ticket.findOneAndUpdate(
      { _id: seat._id, holderStatus: "unassigned" },
      {
        $set: {
          holderStatus: "accepted",
          holderName: name,
          holderPhone: phone,
          holderEmail: realEmail(user?.email),
          ...(user ? { holderUser: user._id } : {}),
          requestedAt: now,
          acceptedAt: now,
          qrCodeToken: generateQrCodeToken()
        }
      },
      { returnDocument: "after" }
    );
    if (!updated) {
      res.status(409).json({ success: false, message: "This seat isn't open anymore" });
      return;
    }
    await TicketOrder.updateOne({ _id: order._id }, { $pull: { rejectedPhones: phone } });

    void notify("accepted", order, updated, { name, phone, email: realEmail(user?.email) });
    res.status(200).json({ success: true, seat: seatForBuyer(updated) });
  } catch (error: any) {
    next(new Error(`Failed to assign seat: ${error.message}`));
  }
};

/* ─────────────────────────────── Guest actions ─────────────────────────────── */

/**
 * POST /api/tickets/seats/:ticketId/cancel
 * Guest withdraws a pending request (any time) or gives back an accepted ticket
 * (only until 48h after the buyer's purchase). The seat returns to the buyer.
 */
export const cancelMySeat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Please sign in" });
      return;
    }
    const ticketId = sanitizeString(req.params.ticketId);
    const seat = OBJECT_ID.test(ticketId) ? await Ticket.findById(ticketId) : null;
    const me = await loadMe(String(req.user._id));
    if (!seat || seat.isBuyerSeat || !seat.holderStatus || !["pending", "accepted"].includes(seat.holderStatus) || !isTicketHolder(seat, me)) {
      res.status(404).json({ success: false, message: "Ticket not found" });
      return;
    }
    if (seat.checkedIn) {
      res.status(409).json({ success: false, message: "This ticket was already used at the door" });
      return;
    }
    const order = await TicketOrder.findById(seat.order).populate("event", EVENT_FIELDS);
    if (!order) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }
    if (seat.holderStatus === "accepted" && order.guestCancelDeadline && Date.now() > order.guestCancelDeadline.getTime()) {
      res.status(403).json({
        success: false,
        code: "CANCEL_WINDOW_CLOSED",
        message: "Tickets can only be cancelled within 48 hours of the purchase."
      });
      return;
    }

    const wasStatus = seat.holderStatus;
    const guest: TicketGuestInfo = { name: seat.holderName || "Guest", phone: seat.holderPhone || "", email: seat.holderEmail };
    const updated = await Ticket.findOneAndUpdate(
      { _id: seat._id, holderStatus: wasStatus, checkedIn: false },
      { ...UNASSIGN, $set: { ...UNASSIGN.$set, qrCodeToken: generateQrCodeToken() } },
      { returnDocument: "after" }
    );
    if (!updated) {
      res.status(409).json({ success: false, message: "This ticket changed. Please refresh." });
      return;
    }

    logger.info(`Guest ${guest.name} gave back seat ${seat.ticketCode} (${order.orderNumber}, was ${wasStatus})`);
    void notify("cancelled", order, updated, guest);

    res.status(200).json({
      success: true,
      message: wasStatus === "pending" ? "Request withdrawn" : `Ticket cancelled. ${firstName(order.customerName)} has been notified.`
    });
  } catch (error: any) {
    next(new Error(`Failed to cancel ticket: ${error.message}`));
  }
};

/**
 * GET /api/tickets/seats/:ticketId/live-qr
 * Current rotating door QR for the signed-in holder of an accepted, unused ticket.
 */
export const getLiveQr = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Please sign in" });
      return;
    }
    const ticketId = sanitizeString(req.params.ticketId);
    const ticket = OBJECT_ID.test(ticketId) ? await Ticket.findById(ticketId) : null;
    const me = await loadMe(String(req.user._id));
    if (!ticket || !isTicketHolder(ticket, me)) {
      res.status(404).json({ success: false, message: "Ticket not found" });
      return;
    }
    if (ticket.holderStatus && ticket.holderStatus !== "accepted") {
      res.status(409).json({ success: false, code: "NOT_ACCEPTED", message: "Your ticket appears once the buyer accepts you." });
      return;
    }
    if (ticket.status !== "valid" && ticket.status !== "used") {
      res.status(410).json({ success: false, code: "TICKET_VOID", message: `This ticket was ${ticket.status}.` });
      return;
    }
    // Link a buyer-assigned seat to the account that just proved the phone number
    if (ticket.holderStatus && !ticket.holderUser) {
      await Ticket.updateOne({ _id: ticket._id, holderUser: { $exists: false } }, { $set: { holderUser: me!._id } });
    }

    res.set("Cache-Control", "no-store");
    res.status(200).json({
      success: true,
      checkedIn: ticket.checkedIn,
      checkedInAt: ticket.checkedInAt,
      ...(ticket.checkedIn ? {} : issueLiveQr(String(ticket._id), ticket.qrCodeToken))
    });
  } catch (error: any) {
    next(new Error(`Failed to load live QR: ${error.message}`));
  }
};

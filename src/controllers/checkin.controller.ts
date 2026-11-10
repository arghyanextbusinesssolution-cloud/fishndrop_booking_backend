import { NextFunction, Request, Response } from "express";
import Ticket from "../models/Ticket";
import TicketOrder from "../models/TicketOrder";
import Event from "../models/Event";
import GuestPass from "../models/GuestPass";
import { sendGHLTicketCheckedInEvent, sendGHLGuestPassCheckedInEvent } from "../integrations/ghl";
import logger from "../config/logger";
import { isLiveQrToken, parseLiveQr, verifyLiveQr } from "../utils/liveQr.utils";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

/**
 * POST /api/check-in/scan
 * Validates a scanned QR code token or pass code at the venue door.
 * Supports BOTH public event tickets AND private venue booking guest passes!
 */
export const scanTicket = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawCode = sanitizeString(req.body.token || req.body.ticketCode || req.body.code);

    if (!rawCode) {
      res.status(400).json({ success: false, message: "QR token or ticket code is required" });
      return;
    }

    const isPromoterUser = req.user?.role === "promoter";

    // 0. Group QR: one code admits every not-yet-admitted ticket in the order
    if (rawCode.startsWith("grp_")) {
      const order = await TicketOrder.findOne({ groupQrToken: rawCode }).populate("event");
      if (!order || order.qrMode !== "group" || order.status !== "paid") {
        res.status(404).json({
          success: false,
          code: "INVALID_GROUP_PASS",
          message: order && order.qrMode !== "group"
            ? "This group QR was replaced by individual QR codes. Ask the guests to show their own passes."
            : "Group pass not found or not valid."
        });
        return;
      }
      const event = order.event as any;
      if (isPromoterUser && String(order.promoter) !== req.user!._id.toString()) {
        res.status(403).json({ success: false, code: "NOT_YOUR_EVENT", message: "This pass belongs to another promoter's event." });
        return;
      }

      const all = await Ticket.find({ order: order._id, status: { $in: ["valid", "used"] } });
      const pending = all.filter((t) => !t.checkedIn);
      const staffName = req.user?.name || "Staff Member";

      if (pending.length === 0) {
        const last = all.reduce<Date | undefined>((d, t) => (t.checkedInAt && (!d || t.checkedInAt > d) ? t.checkedInAt : d), undefined);
        res.status(409).json({
          success: false,
          code: "ALREADY_CHECKED_IN",
          message: `DUPLICATE ADMISSION: All ${all.length} people on this group pass are already checked in${
            last ? ` (last at ${last.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})` : ""
          }.`,
          ticket: { ticketCode: order.orderNumber, customerName: order.customerName, tierName: `Group pass · ${all.length} people` }
        });
        return;
      }

      const now = new Date();
      await Ticket.updateMany(
        { _id: { $in: pending.map((t) => t._id) }, checkedIn: false },
        { $set: { checkedIn: true, checkedInAt: now, checkedInBy: req.user?._id, checkedInByName: staffName, status: "used" } }
      );
      for (const t of pending) void sendGHLTicketCheckedInEvent(t, event, staffName);

      const tiers = pending.reduce<Record<string, number>>((m, t) => ((m[t.tierName] = (m[t.tierName] || 0) + 1), m), {});
      const tierText = Object.entries(tiers).map(([n, c]) => `${c}× ${n}`).join(", ");
      const already = all.length - pending.length;
      logger.info(`Staff ${staffName} admitted ${pending.length}/${all.length} via group pass ${order.orderNumber} for ${event?.title}`);

      res.status(200).json({
        success: true,
        code: "CHECK_IN_SUCCESS",
        message: `GROUP ADMISSION: Admit ${pending.length} ${pending.length === 1 ? "person" : "people"}${
          already ? ` (${already} already inside)` : ""
        }. Welcome, ${order.customerName}'s group!`,
        admitted: pending.length,
        groupSize: all.length,
        ticket: {
          ticketCode: order.orderNumber,
          customerName: `${order.customerName} + group`,
          customerEmail: order.customerEmail,
          tierName: tierText,
          eventTitle: event?.title,
          venueName: event?.venueName,
          checkedInAt: now.toISOString(),
          checkedInByName: staffName
        }
      });
      return;
    }

    // 1. Event tickets. Guest-sharing tickets only admit with the rotating live QR
    //    (tk_…, valid 5 minutes from issue) or a ticket code typed by staff; a static QR screenshot is refused.
    let ticket;
    if (isLiveQrToken(rawCode)) {
      const parsed = parseLiveQr(rawCode);
      ticket = parsed ? await Ticket.findById(parsed.ticketId).populate("event") : null;
      const check = ticket ? verifyLiveQr(rawCode, ticket.qrCodeToken) : "invalid";
      if (check !== "ok") {
        res.status(check === "expired" ? 400 : 404).json({
          success: false,
          code: check === "expired" ? "QR_EXPIRED" : "INVALID_TICKET",
          message:
            check === "expired"
              ? "QR EXPIRED: this code is older than 5 minutes (likely a screenshot). Ask the guest to open their live ticket in the app."
              : "Admission not recognized. Invalid QR code."
        });
        return;
      }
    } else {
      ticket = await Ticket.findOne({
        $or: [{ qrCodeToken: rawCode }, { ticketCode: rawCode.toUpperCase() }]
      }).populate("event");
      if (ticket && ticket.holderStatus && ticket.qrCodeToken === rawCode) {
        res.status(400).json({
          success: false,
          code: "STATIC_QR_NOT_ACCEPTED",
          message: "Old or screenshot QR. Ask the guest to open their live ticket in the app (the code changes every 5 minutes)."
        });
        return;
      }
    }

    const isPromoter = req.user?.role === "promoter";

    if (ticket) {
      const event = ticket.event as any;
      const attendeeName = ticket.holderName || ticket.customerName;
      const tierLabel =
        ticket.holderStatus && !ticket.isBuyerSeat ? `${ticket.tierName} · Guest of ${ticket.customerName}` : ticket.tierName;

      if (ticket.holderStatus && ticket.holderStatus !== "accepted") {
        res.status(400).json({
          success: false,
          code: ticket.holderStatus === "pending" ? "GUEST_NOT_APPROVED" : "SEAT_NOT_ASSIGNED",
          message:
            ticket.holderStatus === "pending"
              ? `${attendeeName} is still waiting for ${ticket.customerName} to accept them.`
              : `This seat on ${ticket.customerName}'s order hasn't been given to anyone yet.`
        });
        return;
      }

      if (isPromoter && String(ticket.promoter) !== req.user!._id.toString()) {
        res.status(403).json({
          success: false,
          code: "NOT_YOUR_EVENT",
          message: "This ticket belongs to another promoter's event."
        });
        return;
      }

      if (ticket.status === "refunded") {
        res.status(400).json({
          success: false,
          code: "TICKET_REFUNDED",
          message: `This ticket was REFUNDED on ${ticket.updatedAt?.toLocaleDateString()} and is void.`
        });
        return;
      }

      if (ticket.status === "cancelled") {
        res.status(400).json({
          success: false,
          code: "TICKET_CANCELLED",
          message: "This ticket has been cancelled."
        });
        return;
      }

      if (ticket.checkedIn) {
        const checkInTime = ticket.checkedInAt
          ? new Date(ticket.checkedInAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "earlier";
        res.status(409).json({
          success: false,
          code: "ALREADY_CHECKED_IN",
          message: `DUPLICATE ADMISSION: Already checked in at ${checkInTime} by ${ticket.checkedInByName || "Staff"}.`,
          ticket: {
            ticketCode: ticket.ticketCode,
            customerName: attendeeName,
            tierName: tierLabel,
            checkedInAt: ticket.checkedInAt?.toISOString(),
            checkedInByName: ticket.checkedInByName
          }
        });
        return;
      }

      // Atomic: two doors scanning the same code at once can't both admit it
      const checkedInAt = new Date();
      const staffName = req.user?.name || "Staff Member";
      const admitted = await Ticket.updateOne(
        { _id: ticket._id, checkedIn: false },
        { $set: { checkedIn: true, checkedInAt, checkedInBy: req.user?._id, checkedInByName: staffName, status: "used" } }
      );
      if (admitted.modifiedCount === 0) {
        res.status(409).json({
          success: false,
          code: "ALREADY_CHECKED_IN",
          message: "DUPLICATE ADMISSION: This ticket was just checked in at another door.",
          ticket: { ticketCode: ticket.ticketCode, customerName: attendeeName, tierName: tierLabel }
        });
        return;
      }
      ticket.checkedIn = true;
      ticket.checkedInAt = checkedInAt;
      ticket.checkedInByName = staffName;
      ticket.status = "used";

      logger.info(`Staff ${ticket.checkedInByName} checked in ticket ${ticket.ticketCode} for ${event?.title}`);

      void sendGHLTicketCheckedInEvent(ticket, event, ticket.checkedInByName);

      res.status(200).json({
        success: true,
        code: "CHECK_IN_SUCCESS",
        message: `Admission Confirmed! Welcome, ${attendeeName}.`,
        ticket: {
          ticketCode: ticket.ticketCode,
          customerName: attendeeName,
          customerEmail: ticket.holderEmail || ticket.customerEmail,
          tierName: tierLabel,
          eventTitle: event?.title,
          venueName: event?.venueName,
          checkedInAt: ticket.checkedInAt.toISOString(),
          checkedInByName: ticket.checkedInByName
        }
      });
      return;
    }

    // 2. Try finding in Private Booking Guest Passes
    const guestPass = await GuestPass.findOne({
      $or: [{ qrCodeToken: rawCode }, { passCode: rawCode.toUpperCase() }]
    }).populate("booking");

    if (guestPass && isPromoter) {
      res.status(403).json({
        success: false,
        code: "NOT_YOUR_EVENT",
        message: "Private venue guest passes are checked in by venue staff."
      });
      return;
    }

    if (guestPass) {
      const booking = guestPass.booking as any;

      if (guestPass.status === "rejected") {
        res.status(400).json({
          success: false,
          code: "PASS_REJECTED",
          message: "This private guest pass was declined by the host."
        });
        return;
      }
      if (guestPass.status !== "approved") {
        res.status(400).json({
          success: false,
          code: "PASS_PENDING",
          message: `This guest is still waiting for ${booking?.customerName || "the host"} to approve them.`
        });
        return;
      }
      if (booking?.status === "cancelled") {
        res.status(400).json({ success: false, code: "BOOKING_CANCELLED", message: "This private event booking was cancelled." });
        return;
      }

      if (guestPass.checkedIn) {
        const checkInTime = guestPass.checkedInAt
          ? new Date(guestPass.checkedInAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "earlier";
        res.status(409).json({
          success: false,
          code: "ALREADY_CHECKED_IN",
          message: `DUPLICATE ADMISSION: Private guest pass already checked in at ${checkInTime} by ${guestPass.checkedInByName || "Staff"}.`,
          ticket: {
            ticketCode: guestPass.passCode,
            customerName: guestPass.guestName,
            tierName: `Private Guest (${booking?.occasion?.toUpperCase() || "EVENT"})`,
            checkedInAt: guestPass.checkedInAt?.toISOString(),
            checkedInByName: guestPass.checkedInByName
          }
        });
        return;
      }

      guestPass.checkedIn = true;
      guestPass.checkedInAt = new Date();
      guestPass.checkedInBy = req.user?._id;
      guestPass.checkedInByName = req.user?.name || "Staff Member";
      await guestPass.save();

      res.status(200).json({
        success: true,
        code: "CHECK_IN_SUCCESS",
        message: `Admission Confirmed! Welcome, ${guestPass.guestName} (Guest of ${booking?.customerName || "Host"}).`,
        ticket: {
          ticketCode: guestPass.passCode,
          customerName: guestPass.guestName,
          customerEmail: guestPass.guestEmail,
          tierName: `Private Guest (${booking?.occasion?.toUpperCase() || "EVENT"})`,
          eventTitle: `Private Event Hosted by ${booking?.customerName || "Host"}`,
          venueName: "Tropica Sanctuary NYC",
          checkedInAt: guestPass.checkedInAt.toISOString(),
          checkedInByName: guestPass.checkedInByName
        }
      });
      return;
    }

    res.status(404).json({
      success: false,
      code: "INVALID_TICKET",
      message: "Admission not recognized. Invalid QR code or ticket number."
    });
  } catch (error: any) {
    logger.error("Scan ticket error", { error: error.message });
    next(new Error(`Check-in processing error: ${error.message}`));
  }
};

/**
 * GET /api/check-in/search
 * Manual ticket and guest pass lookup by customer name, email, phone, or code.
 */
export const searchTickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const query = sanitizeString(req.query.q);
    if (!query || query.length < 2) {
      res.status(400).json({ success: false, message: "Search term must be at least 2 characters" });
      return;
    }

    const safe = query.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const digits = query.replace(/\D/g, "");
    const ticketFilter: any = {
      $or: [
        { ticketCode: { $regex: safe, $options: "i" } },
        { customerName: { $regex: safe, $options: "i" } },
        { holderName: { $regex: safe, $options: "i" } },
        { customerEmail: { $regex: safe, $options: "i" } },
        ...(digits.length >= 3 ? [{ customerPhone: { $regex: digits } }, { holderPhone: { $regex: digits } }] : [])
      ]
    };

    const isPromoter = req.user?.role === "promoter";
    if (isPromoter) ticketFilter.promoter = req.user!._id;

    const ticketDocs = await Ticket.find(ticketFilter)
      .populate("event", "title date venueName startTime")
      .limit(15)
      .sort({ createdAt: -1 })
      .lean();
    const tickets = ticketDocs.map((t: any) => ({
      ...t,
      customerName: t.holderName || (t.holderStatus === "unassigned" ? `Open seat (${t.customerName})` : t.customerName),
      customerPhone: t.holderPhone || t.customerPhone,
      tierName:
        t.holderStatus && !t.isBuyerSeat
          ? `${t.tierName} · ${t.holderStatus === "accepted" ? `Guest of ${t.customerName}` : t.holderStatus === "pending" ? "Awaiting buyer approval" : "Unassigned"}`
          : t.tierName
    }));

    const passFilter: any = {
      $or: [
        { passCode: { $regex: safe, $options: "i" } },
        { guestName: { $regex: safe, $options: "i" } },
        { guestEmail: { $regex: safe, $options: "i" } },
        ...(digits.length >= 3 ? [{ guestPhone: { $regex: digits } }] : [])
      ]
    };

    const guestPasses = isPromoter ? [] : await GuestPass.find(passFilter)
      .populate("booking", "customerName occasion bookingDate bookingTime")
      .limit(15)
      .sort({ createdAt: -1 });

    const formattedPasses = guestPasses.map((g: any) => ({
      _id: g._id,
      ticketCode: g.passCode,
      customerName: g.guestName,
      customerEmail: g.guestEmail,
      customerPhone: g.guestPhone,
      tierName: `Private Guest (${g.booking?.occasion?.toUpperCase() || "EVENT"})`,
      event: {
        title: `Private Event Hosted by ${g.booking?.customerName}`,
        date: g.booking?.bookingDate,
        startTime: g.booking?.bookingTime,
        venueName: "Tropica Sanctuary NYC"
      },
      checkedIn: g.checkedIn,
      checkedInAt: g.checkedInAt
    }));

    res.status(200).json({
      success: true,
      count: tickets.length + formattedPasses.length,
      tickets: [...tickets, ...formattedPasses]
    });
  } catch (error: any) {
    next(new Error(`Search failed: ${error.message}`));
  }
};

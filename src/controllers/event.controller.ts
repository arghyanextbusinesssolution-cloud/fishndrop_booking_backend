import { DATE_RE, SALES_CLOSE_MINUTES, TIME_RE, getSalesCloseAt, salesWindow } from "../utils/eventTime.utils";
import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Event, { generateEventSlug } from "../models/Event";
import TicketOrder from "../models/TicketOrder";
import Ticket from "../models/Ticket";
import User from "../models/User";
import SystemSettings from "../models/SystemSettings";
import { sendGHLEventApprovedEvent, sendGHLPromoterEventCreatedEvent } from "../integrations/ghl";
import logger from "../config/logger";
import { v2 as cloudinary } from "cloudinary";

/** Event flyers live on Cloudinary; only the https link is stored and sent to GHL. */
const storeFlyer = async (raw: unknown): Promise<string> => {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (/^https:\/\//i.test(value)) return value.slice(0, 1000);
  const m = value.match(/^data:image\/(?:png|jpe?g|webp|gif|heic|heif);base64,/i);
  if (!m) throw new Error("Unsupported flyer format");
  if (Math.floor((value.length - m[0].length) * 0.75) > 10 * 1024 * 1024) throw new Error("Flyer is larger than 10MB");
  const result = await cloudinary.uploader.upload(value, { folder: "tropica_event_flyers", resource_type: "image" });
  return result.secure_url;
};

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

/**
 * POST /api/events
 * Promoter creates a new event with ticket tiers.
 */
export const createEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const title = sanitizeString(req.body.title);
    const description = sanitizeString(req.body.description);
    const dateStr = sanitizeString(req.body.date);
    const startTime = sanitizeString(req.body.startTime);
    const endTime = sanitizeString(req.body.endTime);
    const venueType = req.body.venueType === "external" ? "external" : "tropica";
    const venueName = sanitizeString(req.body.venueName) || (venueType === "tropica" ? "Tropica Sanctuary NYC" : "External Venue");
    const venueAddress = sanitizeString(req.body.venueAddress) || (venueType === "tropica" ? "Brooklyn, NY" : "");
    let flyerUrl = "";
    try {
      flyerUrl = await storeFlyer(req.body.flyerUrl);
    } catch (err: any) {
      res.status(400).json({ success: false, message: `We couldn't upload the flyer (${err.message}). Please choose it again.` });
      return;
    }
    const rawTiers = Array.isArray(req.body.ticketTiers) ? req.body.ticketTiers : [];

    if (!title || !dateStr || !startTime || !endTime || !flyerUrl) {
      res.status(400).json({
        success: false,
        message: "Title, date, start time, end time, and flyer image are required"
      });
      return;
    }

    if (rawTiers.length === 0) {
      res.status(400).json({
        success: false,
        message: "At least one ticket tier with price and quantity is required"
      });
      return;
    }

    const ticketTiers = rawTiers.map((tier: any) => ({
      name: sanitizeString(tier.name) || "General Admission",
      price: Math.max(0, Number(tier.price) || 0),
      quantity: Math.max(1, Math.floor(Number(tier.quantity) || 1)),
      sold: 0,
      reserved: 0,
      salesDeadline: tier.salesDeadline ? new Date(tier.salesDeadline) : undefined,
      description: sanitizeString(tier.description)
    }));

    if (!DATE_RE.test(dateStr) || !TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
      res.status(400).json({ success: false, message: "Please pick a valid date and start/end time" });
      return;
    }
    if (startTime === endTime) {
      res.status(400).json({ success: false, message: "End time must be different from the start time" });
      return;
    }

    const eventDate = new Date(`${dateStr}T00:00:00.000Z`);
    const salesCloseAt = getSalesCloseAt({ date: eventDate, startTime });
    if (!salesCloseAt || salesCloseAt.getTime() <= Date.now()) {
      res.status(400).json({
        success: false,
        message: `The event must start in the future (at least ${SALES_CLOSE_MINUTES + 1} minutes from now, New York time)`
      });
      return;
    }

    const venueLat = Number(req.body.venueLat);
    const venueLng = Number(req.body.venueLng);
    const venuePlaceId = sanitizeString(req.body.venuePlaceId);

    const slug = generateEventSlug(title);

    const event = await Event.create({
      promoter: req.user._id,
      title,
      slug,
      description,
      date: eventDate,
      startTime,
      endTime,
      venueType,
      venueName,
      venueAddress,
      ...(Number.isFinite(venueLat) && Number.isFinite(venueLng) && Math.abs(venueLat) <= 90 && Math.abs(venueLng) <= 180
        ? { venueLat, venueLng }
        : {}),
      ...(venuePlaceId ? { venuePlaceId: venuePlaceId.slice(0, 300) } : {}),
      flyerUrl,
      ticketTiers,
      status: req.body.status === "draft" ? "draft" : "pending_approval"
    });

    // Push the full event + promoter details + every employee's contact (so GHL can alert the team)
    void Promise.all([
      User.findById(req.user._id).select("name email phone companyName promoterStatus"),
      User.find({ role: "staff" }).select("name email phone").sort({ createdAt: 1 }).lean()
    ])
      .then(([promoter, employees]) => sendGHLPromoterEventCreatedEvent(event, promoter, employees))
      .catch((err) => logger.error("[GHL] Could not load promoter for event webhook", { error: err.message }));

    res.status(201).json({
      success: true,
      message: "Event created and submitted for employee verification",
      event
    });
  } catch (error: any) {
    logger.error("Failed to create event", { error: error.message });
    next(new Error(`Failed to create event: ${error.message}`));
  }
};

/**
 * GET /api/events/my-events
 * Lists all events created by the logged-in promoter.
 */
export const getMyEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const events = await Event.find({ promoter: req.user._id }).populate("approvedBy", "name").sort({ date: -1 });

    const eventSummaries = await Promise.all(
      events.map(async (ev) => {
        const orders = await TicketOrder.find({ event: ev._id, status: "paid" });
        const totalTicketsSold = ev.ticketTiers.reduce((sum, tier) => sum + tier.sold, 0);
        const grossRevenue = orders.reduce((sum, o) => sum + o.subtotal, 0);
        const platformFees = orders.reduce((sum, o) => sum + o.platformFee, 0);
        const netEarnings = grossRevenue - platformFees;

        const checkInCount = await Ticket.countDocuments({ event: ev._id, checkedIn: true });

        return {
          ...ev.toObject(),
          totalTicketsSold,
          grossRevenue,
          platformFees,
          netEarnings,
          checkInCount
        };
      })
    );

    res.status(200).json({ success: true, count: eventSummaries.length, events: eventSummaries });
  } catch (error: any) {
    next(new Error(`Failed to fetch promoter events: ${error.message}`));
  }
};

/**
 * GET /api/events/promoter/dashboard-stats
 * Comprehensive metrics for promoter dashboard: tickets sold, revenue, fees, payouts.
 */
export const getPromoterDashboardStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const promoterId = req.user._id;
    const events = await Event.find({ promoter: promoterId });
    const eventIds = events.map((e) => e._id);

    const paidOrders = await TicketOrder.find({ event: { $in: eventIds }, status: "paid" });
    const refundedOrders = await TicketOrder.find({ event: { $in: eventIds }, status: "refunded" });

    const totalTicketsSold = events.reduce(
      (sum, ev) => sum + ev.ticketTiers.reduce((tSum, t) => tSum + t.sold, 0),
      0
    );

    const grossRevenue = paidOrders.reduce((sum, o) => sum + o.subtotal, 0);
    const platformFees = paidOrders.reduce((sum, o) => sum + o.platformFee, 0);
    const processingFees = paidOrders.reduce((sum, o) => sum + (o.processingFee || 0), 0);
    const refundTotal = refundedOrders.reduce((sum, o) => sum + (o.refundAmount || o.totalAmount), 0);
    const netEarnings = Math.max(0, grossRevenue - platformFees - refundTotal);

    const checkInCount = await Ticket.countDocuments({ event: { $in: eventIds }, checkedIn: true });

    const user = await User.findById(promoterId);

    res.status(200).json({
      success: true,
      stats: {
        totalEvents: events.length,
        totalTicketsSold,
        grossRevenue,
        platformFees,
        processingFees,
        refundTotal,
        netEarnings,
        checkInCount,
        stripeConnectOnboarded: Boolean(user?.stripeConnectOnboarded),
        chargesEnabled: Boolean(user?.chargesEnabled),
        payoutsEnabled: Boolean(user?.payoutsEnabled),
        promoterStatus: user?.promoterStatus || "pending"
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch promoter dashboard stats: ${error.message}`));
  }
};

/**
 * GET /api/events/public
 * Returns all published upcoming events for the public directory.
 */
export const getPublicEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const events = await Event.find({
      status: "published",
      date: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    })
      .populate("promoter", "name companyName")
      .sort({ date: 1 });

    const publicList = events.map((ev) => {
      const obj = ev.toObject();
      const tiersWithAvailability = obj.ticketTiers.map((tier) => ({
        _id: tier._id,
        name: tier.name,
        price: tier.price,
        description: tier.description,
        available: Math.max(0, tier.quantity - tier.sold - tier.reserved),
        isSoldOut: tier.sold + tier.reserved >= tier.quantity
      }));
      return {
        ...obj,
        ticketTiers: tiersWithAvailability,
        ...salesWindow(obj)
      };
    });

    res.status(200).json({ success: true, count: publicList.length, events: publicList });
  } catch (error: any) {
    next(new Error(`Failed to fetch public events: ${error.message}`));
  }
};

/**
 * GET /api/events/slug/:slug
 * Retrieves public event details and live ticket tier availability.
 */
export const getEventBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const event = await Event.findOne({ slug }).populate("promoter", "name companyName chargesEnabled platformFeeOverride");

    if (!event) {
      res.status(404).json({ success: false, message: "Event not found" });
      return;
    }

    // Unverified / draft events are NOT publicly accessible
    if (event.status !== "published") {
      let isAuthorized = false;
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : (req as any).cookies?.token;
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
          const user = await User.findById(decoded.id);
          if (
            user &&
            (["admin", "owner", "staff"].includes(user.role) ||
              String(user._id) === String((event.promoter as any)?._id || event.promoter))
          ) {
            isAuthorized = true;
          }
        } catch {
          // Token invalid
        }
      }

      if (!isAuthorized) {
        res.status(403).json({
          success: false,
          isPendingApproval: true,
          message: "This event is currently pending employee verification and is not yet publicly published."
        });
        return;
      }
    }

    const obj: any = event.toObject();
    if (obj.promoter && typeof obj.promoter === "object") {
      // Public payload: only display fields of the promoter
      obj.promoter = { _id: obj.promoter._id, name: obj.promoter.name, companyName: obj.promoter.companyName };
    }
    const tiersWithAvailability = obj.ticketTiers.map((tier: any) => ({
      _id: tier._id,
      name: tier.name,
      price: tier.price,
      description: tier.description,
      salesDeadline: tier.salesDeadline,
      available: Math.max(0, tier.quantity - tier.sold - tier.reserved),
      isSoldOut: tier.sold + tier.reserved >= tier.quantity
    }));

    // Fetch active platform fee setting to display fees transparently if customer_paid
    const settings = await (SystemSettings as any).getSettings();
    // Same precedence as checkout: event override > promoter override > platform default
    const promoterDoc = event.promoter as any;
    const effectiveFeePercent =
      event.feeOverridePercent ?? promoterDoc?.platformFeeOverride ?? settings.platformFeePercent ?? 3.0;
    const effectiveFixedFee = event.fixedFeeOverride ?? settings.platformFixedFee ?? 0.0;
    const feeMode = event.feeModeOverride ?? settings.feeMode ?? "customer_paid";

    res.status(200).json({
      success: true,
      event: {
        ...obj,
        ticketTiers: tiersWithAvailability,
        ...salesWindow(obj),
        feeInfo: {
          feePercent: effectiveFeePercent,
          fixedFee: effectiveFixedFee,
          feeMode
        }
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch event by slug: ${error.message}`));
  }
};

/**
 * PATCH /api/events/:id/publish-request
 * Promoter submits draft event for staff/admin approval.
 */
export const requestEventApproval = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const event = await Event.findOne({ _id: req.params.id, promoter: req.user._id });
    if (!event) {
      res.status(404).json({ success: false, message: "Event not found" });
      return;
    }

    const promoter = await User.findById(req.user._id);
    if (!promoter || promoter.promoterStatus !== "approved") {
      res.status(403).json({
        success: false,
        message: "Your promoter account must be approved before you can submit events for publication."
      });
      return;
    }

    event.status = "pending_approval";
    await event.save();

    res.status(200).json({
      success: true,
      message: "Event submitted for staff review and publication",
      event
    });
  } catch (error: any) {
    next(new Error(`Failed to submit event: ${error.message}`));
  }
};

/**
 * PATCH /api/events/:id/admin-approve
 * Admin reviews and approves or rejects an event for publication.
 */
export const adminApproveEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const action = sanitizeString(req.body.action); // "published" | "cancelled"
    const notes = sanitizeString(req.body.notes);
    const feeOverridePercent = req.body.feeOverridePercent !== undefined ? Number(req.body.feeOverridePercent) : undefined;

    // Only these two actions are valid; anything else used to silently cancel the event
    if (action !== "published" && action !== "cancelled") {
      res.status(400).json({ success: false, message: "action must be 'published' or 'cancelled'" });
      return;
    }

    const event = await Event.findById(id).populate("promoter");
    if (!event) {
      res.status(404).json({ success: false, message: "Event not found" });
      return;
    }

    if (action === "published") {
      event.status = "published";
      event.approvedBy = req.user?._id;
      event.approvedAt = new Date();
      event.rejectionReason = undefined;
      if (feeOverridePercent !== undefined && !isNaN(feeOverridePercent)) {
        event.feeOverridePercent = feeOverridePercent;
      }
    } else {
      event.status = "cancelled";
      event.rejectionReason = notes || "Event does not meet venue criteria";
    }

    await event.save();

    // Notify GHL only after the approval is persisted
    if (action === "published") {
      void sendGHLEventApprovedEvent(event, event.promoter, req.user);
    }

    res.status(200).json({
      success: true,
      message: `Event status updated to ${event.status}`,
      event
    });
  } catch (error: any) {
    next(new Error(`Failed to approve event: ${error.message}`));
  }
};

/**
 * GET /api/events/admin/all
 * Staff and Admin retrieve all promoter events with promoter details.
 */
export const getAllEventsForAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = req.query.status ? sanitizeString(String(req.query.status)) : undefined;
    const filter: any = {};
    if (status && status !== "all") {
      filter.status = status;
    }

    const events = await Event.find(filter)
      .populate("promoter", "name email phone companyName promoterStatus")
      .populate("approvedBy", "name")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      events
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch events for admin: ${error.message}`));
  }
};



/**
 * GET /api/events/:id/bookings
 * Full ticket-booking ledger for one event: who booked, how many, amount paid, ticket status.
 * Access: admin / staff (any event) or the promoter who owns the event.
 */
export const getEventBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const id = sanitizeString(req.params.id);
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      res.status(400).json({ success: false, message: "Invalid event id" });
      return;
    }

    const event = await Event.findById(id).populate("promoter", "name email phone companyName");
    if (!event) {
      res.status(404).json({ success: false, message: "Event not found" });
      return;
    }

    const isStaff = ["admin", "owner", "staff"].includes(req.user.role);
    const promoterId = (event.promoter as any)?._id?.toString?.() || String(event.promoter);
    if (!isStaff && promoterId !== req.user._id.toString()) {
      res.status(403).json({ success: false, message: "You can only view bookings for your own events" });
      return;
    }

    const statusFilter = sanitizeString(String(req.query.status || "paid"));
    const orderFilter: any = { event: event._id };
    if (statusFilter !== "all") orderFilter.status = statusFilter;

    const [orders, tickets] = await Promise.all([
      TicketOrder.find(orderFilter).sort({ paidAt: -1, createdAt: -1 }).lean(),
      Ticket.find({ event: event._id })
        .select("ticketCode order tierName price status checkedIn checkedInAt checkedInByName customerName")
        .lean()
    ]);

    const ticketsByOrder = new Map<string, any[]>();
    for (const t of tickets) {
      const key = String(t.order);
      if (!ticketsByOrder.has(key)) ticketsByOrder.set(key, []);
      ticketsByOrder.get(key)!.push({
        ticketCode: t.ticketCode,
        tierName: t.tierName,
        price: t.price,
        status: t.status,
        checkedIn: t.checkedIn,
        checkedInAt: t.checkedInAt,
        checkedInByName: t.checkedInByName
      });
    }

    const bookings = orders.map((o: any) => {
      const orderTickets = ticketsByOrder.get(String(o._id)) || [];
      return {
        orderId: o._id,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        customerPhone: o.customerPhone,
        items: o.items,
        ticketCount: o.items.reduce((sum: number, i: any) => sum + i.quantity, 0),
        subtotal: o.subtotal,
        platformFee: o.platformFee,
        totalAmount: o.totalAmount,
        status: o.status,
        paidAt: o.paidAt,
        createdAt: o.createdAt,
        checkedInCount: orderTickets.filter((t) => t.checkedIn).length,
        tickets: orderTickets
      };
    });

    const paid = orders.filter((o: any) => o.status === "paid");
    const summary = {
      totalOrders: paid.length,
      ticketsSold: event.ticketTiers.reduce((sum, t) => sum + t.sold, 0),
      ticketsCapacity: event.ticketTiers.reduce((sum, t) => sum + t.quantity, 0),
      ticketsReserved: event.ticketTiers.reduce((sum, t) => sum + t.reserved, 0),
      checkedIn: tickets.filter((t) => t.checkedIn).length,
      grossRevenue: Math.round(paid.reduce((s: number, o: any) => s + o.subtotal, 0) * 100) / 100,
      platformFees: Math.round(paid.reduce((s: number, o: any) => s + o.platformFee, 0) * 100) / 100,
      totalCollected: Math.round(paid.reduce((s: number, o: any) => s + o.totalAmount, 0) * 100) / 100,
      tiers: event.ticketTiers.map((t) => ({
        name: t.name,
        price: t.price,
        capacity: t.quantity,
        sold: t.sold,
        reserved: t.reserved,
        remaining: Math.max(0, t.quantity - t.sold - t.reserved)
      }))
    };

    res.status(200).json({
      success: true,
      event: {
        _id: event._id,
        title: event.title,
        slug: event.slug,
        date: event.date,
        startTime: event.startTime,
        endTime: event.endTime,
        venueName: event.venueName,
        status: event.status,
        promoter: event.promoter
      },
      summary,
      bookings
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch event bookings: ${error.message}`));
  }
};

/**
 * GET /api/events/promoter/bookings?eventId=&status=paid|all&q=&page=&limit=
 * Sales history across all of the logged-in promoter's events (newest first).
 */
export const getPromoterBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "25"), 10) || 25));
    const status = sanitizeString(String(req.query.status || "paid"));
    const eventId = sanitizeString(String(req.query.eventId || ""));
    const q = sanitizeString(String(req.query.q || "")).slice(0, 60);

    const filter: any = { promoter: req.user._id };
    if (status !== "all") filter.status = status;
    if (/^[a-f0-9]{24}$/i.test(eventId)) filter.event = eventId;
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escape regex special chars
      filter.$or = [
        { customerName: { $regex: safe, $options: "i" } },
        { customerEmail: { $regex: safe, $options: "i" } },
        { customerPhone: { $regex: safe, $options: "i" } },
        { orderNumber: { $regex: safe, $options: "i" } }
      ];
    }

    const [orders, total, totalsAgg] = await Promise.all([
      TicketOrder.find(filter)
        .populate("event", "title slug date startTime")
        .sort({ paidAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TicketOrder.countDocuments(filter),
      // Aggregations don't auto-cast ids, so build the totals filter with real ObjectIds
      TicketOrder.aggregate([
        {
          $match: {
            promoter: new mongoose.Types.ObjectId(String(req.user._id)),
            status: "paid",
            ...(filter.event ? { event: new mongoose.Types.ObjectId(eventId) } : {}),
            ...(filter.$or ? { $or: filter.$or } : {})
          }
        },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            tickets: { $sum: { $sum: "$items.quantity" } },
            gross: { $sum: "$subtotal" },
            fees: { $sum: "$platformFee" },
            collected: { $sum: "$totalAmount" }
          }
        }
      ])
    ]);

    const orderIds = orders.map((o: any) => o._id);
    const checkedIn = await Ticket.aggregate([
      { $match: { order: { $in: orderIds }, checkedIn: true } },
      { $group: { _id: "$order", n: { $sum: 1 } } }
    ]);
    const checkedInMap = new Map(checkedIn.map((c: any) => [String(c._id), c.n]));

    const t = totalsAgg[0] || { orders: 0, tickets: 0, gross: 0, fees: 0, collected: 0 };
    const round = (n: number) => Math.round(n * 100) / 100;

    res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      totals: {
        orders: t.orders,
        tickets: t.tickets,
        gross: round(t.gross),
        fees: round(t.fees),
        collected: round(t.collected),
        // Same definition as the promoter dashboard (getMyEvents / dashboard-stats)
        netEarnings: round(t.gross - t.fees)
      },
      bookings: orders.map((o: any) => ({
        orderId: o._id,
        orderNumber: o.orderNumber,
        event: o.event,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        customerPhone: o.customerPhone,
        items: o.items,
        ticketCount: o.items.reduce((s: number, i: any) => s + i.quantity, 0),
        subtotal: o.subtotal,
        platformFee: o.platformFee,
        totalAmount: o.totalAmount,
        status: o.status,
        paidAt: o.paidAt,
        createdAt: o.createdAt,
        checkedInCount: checkedInMap.get(String(o._id)) || 0
      }))
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch promoter bookings: ${error.message}`));
  }
};

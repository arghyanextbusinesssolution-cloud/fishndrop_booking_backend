import { NextFunction, Request, Response } from "express";
import { getFrontendBaseUrl } from "../utils/siteUrl";
import Booking from "../models/Booking";
import GuestPass, { generateGuestPassCode, generateGuestQrToken } from "../models/GuestPass";
import logger from "../config/logger";
import { sendGHLGuestPassIssuedEvent, sendGHLGuestPassCancelledEvent } from "../integrations/ghl";
import jwt from "jsonwebtoken";
import User from "../models/User";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";


const VENUE_NAME = "Tropica Sanctuary NYC";
const VENUE_ADDRESS = process.env.TROPICA_ADDRESS || "Brooklyn, NY";

/** Invites only work for live, paid (or Zelle-proof-submitted) private bookings. */
const isInvitable = (b: any): boolean =>
  !!b &&
  b.bookingType === "private_event" &&
  b.status !== "cancelled" &&
  (b.status === "confirmed" ||
    ["deposit_paid", "paid"].includes(b.paymentStatus) ||
    (b.paymentMethod === "zelle" && !!b.zelleProofUrl));

/** Optional auth: who is viewing (no 401 for anonymous guests). */
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

const firstName = (n?: string) => (n || "").trim().split(/\s+/)[0] || "Your host";
const activeStatuses = { $in: ["approved", "pending_approval"] };

/** Guests may say they're not attending until 48h after they joined the guest list. */
export const GUEST_PASS_CANCEL_WINDOW_MS = 48 * 60 * 60 * 1000;
const cancelDeadline = (p: any): Date | null => {
  const joined = p?.joinedAt || p?.createdAt;
  return joined ? new Date(new Date(joined).getTime() + GUEST_PASS_CANCEL_WINDOW_MS) : null;
};
const canGuestCancel = (p: any): boolean => {
  if (!p || p.checkedIn || !["approved", "pending_approval"].includes(p.status)) return false;
  const d = cancelDeadline(p);
  return !!d && Date.now() <= d.getTime();
};

const passPublic = (p: any) => ({
  passCode: p.passCode,
  qrCodeToken: p.qrCodeToken,
  status: p.status,
  guestName: p.guestName,
  checkedIn: p.checkedIn,
  cancelDeadline: cancelDeadline(p),
  canCancel: canGuestCancel(p)
});

/**
 * GET /api/invitations/:token
 * Public invitation preview. With a login token, also returns the viewer's own pass.
 */
export const getInvitationDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = sanitizeString(req.params.token);
    const booking = await Booking.findOne({ invitationToken: token });

    if (!booking) {
      res.status(404).json({ success: false, message: "Invitation not found or invalid link" });
      return;
    }
    if (!isInvitable(booking)) {
      res.status(410).json({
        success: false,
        code: "INVITE_INACTIVE",
        message: booking.status === "cancelled" ? "This event was cancelled." : "This invitation isn't active yet. Please check back soon."
      });
      return;
    }

    const registered = await GuestPass.countDocuments({ booking: booking._id, status: activeStatuses });
    const viewerId = optionalUserId(req);
    const myPass = viewerId ? await GuestPass.findOne({ booking: booking._id, user: viewerId }) : null;
    const isHost = !!viewerId && String(booking.user) === viewerId;

    res.status(200).json({
      success: true,
      invitation: {
        hostName: firstName(booking.customerName),
        occasion: booking.occasion || "celebration",
        date: booking.bookingDate,
        startTime: booking.bookingTime,
        endTime: (booking as any).eventEndTime || "",
        durationHours: booking.durationHours,
        venueName: VENUE_NAME,
        venueAddress: VENUE_ADDRESS,
        capacity: booking.partySize,
        registered,
        spotsRemaining: Math.max(0, booking.partySize - registered),
        isCapacityFull: registered >= booking.partySize,
        requireHostApproval: Boolean(booking.requireHostApproval),
        isHost,
        myPass: myPass ? passPublic(myPass) : null
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch invitation: ${error.message}`));
  }
};

/**
 * POST /api/invitations/:token/rsvp   (requires phone-OTP login)
 * Guest joins the host's guest list with their verified Tropica account.
 * Never issues more active passes than the paid guest count.
 */
export const registerGuestForBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, code: "LOGIN_REQUIRED", message: "Please verify your phone number to join" });
      return;
    }
    const token = sanitizeString(req.params.token);
    const nameInput = sanitizeString(req.body.name || req.body.guestName);

    const booking = await Booking.findOne({ invitationToken: token });
    if (!booking) {
      res.status(404).json({ success: false, message: "Invitation not found" });
      return;
    }
    if (!isInvitable(booking)) {
      res.status(410).json({ success: false, code: "INVITE_INACTIVE", message: "This invitation isn't active." });
      return;
    }

    const guest = await User.findById(req.user._id);
    if (!guest || !guest.phone || !guest.isPhoneVerified) {
      res.status(403).json({ success: false, code: "PHONE_VERIFICATION_REQUIRED", message: "Please verify your phone number to join" });
      return;
    }

    const existingName = guest.name && guest.name !== "Guest User" ? guest.name : "";
    const guestName = nameInput || existingName;
    if (!guestName || guestName.length < 2) {
      res.status(400).json({ success: false, code: "NAME_REQUIRED", message: "Please enter your full name" });
      return;
    }
    if (nameInput && nameInput !== guest.name && (!existingName || guest.role === "user")) {
      guest.name = nameInput;
      await guest.save();
    }

    const existingPass = await GuestPass.findOne({
      booking: booking._id,
      $or: [{ user: guest._id }, { guestPhone: guest.phone }]
    });
    if (existingPass && existingPass.status === "cancelled") {
      const activeCount = await GuestPass.countDocuments({ booking: booking._id, status: activeStatuses });
      if (activeCount >= booking.partySize) {
        res.status(403).json({
          success: false,
          code: "CAPACITY_REACHED",
          message: `The guest list is full (${booking.partySize} guests). Please contact ${firstName(booking.customerName)}.`
        });
        return;
      }
      existingPass.user = guest._id as any;
      existingPass.guestName = guestName;
      existingPass.status = booking.requireHostApproval ? "pending_approval" : "approved";
      existingPass.qrCodeToken = generateGuestQrToken();
      existingPass.joinedAt = new Date();
      existingPass.cancelledAt = undefined;
      await existingPass.save();
      logger.info(`Guest ${guestName} re-joined booking #${booking._id} with pass ${existingPass.passCode}`);
      void sendGHLGuestPassIssuedEvent(existingPass, booking);
      res.status(201).json({
        success: true,
        message: existingPass.status === "approved" ? "You're back on the guest list!" : "Request sent! Your host will approve you soon.",
        pass: passPublic(existingPass)
      });
      return;
    }
    if (existingPass) {
      if (!existingPass.user) {
        existingPass.user = guest._id as any;
        await existingPass.save();
      }
      res.status(200).json({ success: true, alreadyRegistered: true, message: "You're already on the guest list.", pass: passPublic(existingPass) });
      return;
    }

    const activePassCount = await GuestPass.countDocuments({ booking: booking._id, status: activeStatuses });
    if (activePassCount >= booking.partySize) {
      res.status(403).json({
        success: false,
        code: "CAPACITY_REACHED",
        message: `The guest list is full (${booking.partySize} guests). Please contact ${firstName(booking.customerName)}.`
      });
      return;
    }

    const passStatus = booking.requireHostApproval ? "pending_approval" : "approved";
    const pass = await GuestPass.create({
      booking: booking._id,
      user: guest._id,
      guestName,
      guestEmail: guest.email && !/^guest_/.test(guest.email) ? guest.email : "",
      guestPhone: guest.phone,
      passCode: generateGuestPassCode(),
      qrCodeToken: generateGuestQrToken(),
      status: passStatus,
      checkedIn: false,
      joinedAt: new Date()
    });

    logger.info(`Issued guest pass ${pass.passCode} to ${guestName} for booking #${booking._id}`);
    void sendGHLGuestPassIssuedEvent(pass, booking);

    res.status(201).json({
      success: true,
      message: passStatus === "approved" ? "You're on the guest list!" : "Request sent! Your host will approve you soon.",
      pass: passPublic(pass)
    });
  } catch (error: any) {
    next(new Error(`Failed to complete RSVP: ${error.message}`));
  }
};

/**
 * POST /api/invitations/:token/cancel   (requires login)
 * Guest says they're not attending. Allowed until 48h after they joined.
 * The pass stops working and the spot opens up again on the guest list.
 */
export const cancelMyGuestPass = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Please sign in" });
      return;
    }
    const token = sanitizeString(req.params.token);
    const booking = await Booking.findOne({ invitationToken: token });
    if (!booking) {
      res.status(404).json({ success: false, message: "Invitation not found" });
      return;
    }

    const me = await User.findById(req.user._id).select("phone isPhoneVerified").lean();
    const or: any[] = [{ user: req.user._id }];
    if (me?.phone && me.isPhoneVerified) or.push({ guestPhone: me.phone });
    const pass = await GuestPass.findOne({ booking: booking._id, $or: or, status: activeStatuses });
    if (!pass) {
      res.status(404).json({ success: false, message: "You're not on this guest list" });
      return;
    }
    if (pass.checkedIn) {
      res.status(409).json({ success: false, message: "This pass was already used at the door" });
      return;
    }
    if (!canGuestCancel(pass)) {
      res.status(403).json({
        success: false,
        code: "CANCEL_WINDOW_CLOSED",
        message: "You can only cancel within 48 hours of joining the guest list."
      });
      return;
    }

    const updated = await GuestPass.findOneAndUpdate(
      { _id: pass._id, status: pass.status, checkedIn: false },
      { $set: { status: "cancelled", cancelledAt: new Date(), qrCodeToken: generateGuestQrToken() } },
      { returnDocument: "after" }
    );
    if (!updated) {
      res.status(409).json({ success: false, message: "Your pass changed. Please refresh." });
      return;
    }

    const active = await GuestPass.countDocuments({ booking: booking._id, status: activeStatuses });
    const spotsRemaining = Math.max(0, booking.partySize - active);
    logger.info(`Guest ${updated.guestName} cancelled pass ${updated.passCode} for booking #${booking._id} (not attending)`);
    void sendGHLGuestPassCancelledEvent(updated, booking, spotsRemaining);

    res.status(200).json({
      success: true,
      message: `You're off the guest list. ${firstName(booking.customerName)} has been notified.`,
      pass: passPublic(updated)
    });
  } catch (error: any) {
    next(new Error(`Failed to cancel your spot: ${error.message}`));
  }
};

/**
 * GET /api/invitations/booking/:bookingId/guests
 * Host views registered guests and attendance.
 */
export const getBookingGuestPasses = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    // Allow booking owner, admin, or staff
    const isOwner = booking.user.toString() === req.user._id.toString();
    const isAdmin = ["admin", "owner", "staff"].includes(req.user.role);

    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    // Ensure booking has an invitation token
    if (!booking.invitationToken) {
      const crypto = await import("crypto");
      booking.invitationToken = crypto.randomBytes(16).toString("hex");
      await booking.save();
    }

    const guestPasses = await GuestPass.find({ booking: booking._id }).sort({ createdAt: -1 });

    const checkedInCount = guestPasses.filter((g) => g.checkedIn).length;
    const approvedCount = guestPasses.filter((g) => g.status === "approved").length;

    const baseUrl = getFrontendBaseUrl();
    const inviteLink = `${baseUrl}/invite/${booking.invitationToken}`;

    res.status(200).json({
      success: true,
      inviteLink,
      invitationToken: booking.invitationToken,
      requireHostApproval: booking.requireHostApproval,
      capacityLimit: booking.partySize,
      invitesActive: isInvitable(booking),
      event: {
        date: booking.bookingDate,
        startTime: booking.bookingTime,
        endTime: (booking as any).eventEndTime || "",
        occasion: booking.occasion || "celebration",
        hostName: firstName(booking.customerName)
      },
      totalRegistered: guestPasses.length,
      approvedCount,
      checkedInCount,
      guests: guestPasses
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch guest passes: ${error.message}`));
  }
};

/**
 * PATCH /api/invitations/passes/:passId/status
 * Host approves or rejects a guest RSVP.
 */
export const updateGuestPassStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { passId } = req.params;
    const { status } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      res.status(400).json({ success: false, message: "Status must be 'approved' or 'rejected'" });
      return;
    }

    const pass = await GuestPass.findById(passId).populate("booking");
    if (!pass) {
      res.status(404).json({ success: false, message: "Guest pass not found" });
      return;
    }

    const booking = pass.booking as any;
    const isOwner = booking.user.toString() === req.user._id.toString();
    const isAdmin = ["admin", "owner", "staff"].includes(req.user.role);

    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    if (pass.status === "cancelled") {
      res.status(409).json({ success: false, message: "This guest cancelled. They're not attending." });
      return;
    }

    pass.status = status;
    await pass.save();

    res.status(200).json({ success: true, message: `Pass ${status} successfully`, pass });
  } catch (error: any) {
    next(new Error(`Failed to update pass: ${error.message}`));
  }
};

/**
 * GET /api/invitations/pass/:qrToken
 * Public endpoint to view individual guest pass.
 */
export const getGuestPassByQrToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = sanitizeString(req.params.qrToken);
    const pass = await GuestPass.findOne({ qrCodeToken: token }).populate("booking");

    if (!pass) {
      res.status(404).json({ success: false, message: "Pass not found" });
      return;
    }

    const booking = pass.booking as any;
    const occasion = String(booking?.occasion || "celebration").replace(/_/g, " ");

    res.status(200).json({
      success: true,
      pass: {
        passCode: pass.passCode,
        guestName: pass.guestName,
        status: pass.status,
        checkedIn: pass.checkedIn,
        checkedInAt: pass.checkedInAt,
        checkedInByName: pass.checkedInByName,
        qrCodeToken: pass.qrCodeToken,
        event: {
          title: `${firstName(booking?.customerName)}'s ${occasion}`,
          hostName: booking?.customerName,
          date: booking?.bookingDate,
          startTime: booking?.bookingTime,
          endTime: booking?.eventEndTime || "",
          venueName: VENUE_NAME,
          venueAddress: VENUE_ADDRESS,
          cancelled: booking?.status === "cancelled"
        }
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch guest pass: ${error.message}`));
  }
};


/**
 * GET /api/invitations/my/celebrations
 * The signed-in host's private venue bookings with guest-list and attendance counts.
 */
export const getMyCelebrations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const bookings = await Booking.find({ user: req.user._id, bookingType: "private_event", status: { $ne: "cancelled" } })
      .select("bookingDate bookingTime eventEndTime durationHours partySize occasion status paymentStatus paymentMethod zelleProofUrl zelleVerificationStatus")
      .sort({ bookingDate: -1 })
      .lean();

    const ids = bookings.map((b) => b._id);
    const counts = await GuestPass.aggregate([
      { $match: { booking: { $in: ids } } },
      {
        $group: {
          _id: "$booking",
          registered: { $sum: { $cond: [{ $in: ["$status", ["approved", "pending_approval"]] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending_approval"] }, 1, 0] } },
          checkedIn: { $sum: { $cond: ["$checkedIn", 1, 0] } }
        }
      }
    ]);
    const byId = new Map(counts.map((c: any) => [String(c._id), c]));

    res.status(200).json({
      success: true,
      celebrations: bookings.map((b: any) => {
        const c = byId.get(String(b._id)) || { registered: 0, pending: 0, checkedIn: 0 };
        return {
          _id: b._id,
          date: b.bookingDate,
          startTime: b.bookingTime,
          endTime: b.eventEndTime || "",
          durationHours: b.durationHours,
          occasion: b.occasion || "celebration",
          capacity: b.partySize,
          registered: c.registered,
          pendingApproval: c.pending,
          checkedIn: c.checkedIn,
          invitesActive: isInvitable(b),
          paymentLabel:
            b.status === "confirmed" || ["deposit_paid", "paid"].includes(b.paymentStatus)
              ? "Confirmed"
              : b.paymentMethod === "zelle" && b.zelleProofUrl
              ? "Zelle verifying"
              : "Awaiting payment"
        };
      })
    });
  } catch (error: any) {
    next(new Error(`Failed to load celebrations: ${error.message}`));
  }
};

/**
 * GET /api/invitations/my/invites
 * Parties the signed-in user joined as a guest (via an invite link).
 */
export const getMyInvites = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const me = await User.findById(req.user._id).select("phone isPhoneVerified").lean();
    const or: any[] = [{ user: req.user._id }];
    if (me?.phone && me.isPhoneVerified) or.push({ guestPhone: me.phone });

    const passes = await GuestPass.find({ $or: or, status: { $nin: ["rejected", "cancelled"] } })
      .populate("booking", "customerName occasion bookingDate bookingTime eventEndTime durationHours status invitationToken user")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const invites = passes
      .filter((p: any) => p.booking && p.booking.status !== "cancelled" && String(p.booking.user) !== String(req.user!._id))
      .map((p: any) => ({
        _id: p._id,
        hostName: firstName(p.booking.customerName),
        occasion: p.booking.occasion || "celebration",
        date: p.booking.bookingDate,
        startTime: p.booking.bookingTime,
        endTime: p.booking.eventEndTime || "",
        venueName: VENUE_NAME,
        venueAddress: VENUE_ADDRESS,
        inviteToken: p.booking.invitationToken,
        passCode: p.passCode,
        qrCodeToken: p.qrCodeToken,
        status: p.status,
        checkedIn: p.checkedIn,
        cancelDeadline: cancelDeadline(p),
        canCancel: canGuestCancel(p)
      }));

    res.status(200).json({ success: true, invites });
  } catch (error: any) {
    next(new Error(`Failed to load your invitations: ${error.message}`));
  }
};

/**
 * GET /api/admin/bookings/:id/overview   (admin / owner / staff)
 * Everything about one booking for the admin & employee detail page:
 * booking + host, guest list, sign-up and door-attendance numbers.
 */
export const getAdminBookingOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = sanitizeString(req.params.id);
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      res.status(400).json({ success: false, message: "Invalid booking id" });
      return;
    }
    const booking = await Booking.findById(id).populate("tables", "tableNumber capacity").populate("user", "name email phone").lean();
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const isPrivate = booking.bookingType === "private_event";
    const passes = isPrivate
      ? await GuestPass.find({ booking: booking._id })
          .select("guestName guestPhone guestEmail passCode status checkedIn checkedInAt checkedInByName createdAt cancelledAt")
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const approved = passes.filter((p) => p.status === "approved");
    const pending = passes.filter((p) => p.status === "pending_approval");
    const rejected = passes.filter((p) => p.status === "rejected");
    const cancelled = passes.filter((p) => p.status === "cancelled");
    const arrived = passes.filter((p) => p.checkedIn);
    const signedUp = approved.length + pending.length;
    const capacity = booking.partySize || 0;

    const baseUrl = getFrontendBaseUrl();
    res.status(200).json({
      success: true,
      booking,
      inviteLink: isPrivate && booking.invitationToken ? `${baseUrl}/invite/${booking.invitationToken}` : null,
      invitesActive: isInvitable(booking),
      stats: {
        capacity,
        signedUp,
        approved: approved.length,
        pendingApproval: pending.length,
        rejected: rejected.length,
        cancelled: cancelled.length,
        spotsLeft: Math.max(0, capacity - signedUp),
        arrived: arrived.length,
        notArrived: Math.max(0, approved.length - arrived.length),
        signUpRate: capacity ? Math.round((signedUp / capacity) * 100) : 0,
        attendanceRate: approved.length ? Math.round((arrived.length / approved.length) * 100) : 0
      },
      guests: passes
    });
  } catch (error: any) {
    next(new Error(`Failed to load booking overview: ${error.message}`));
  }
};

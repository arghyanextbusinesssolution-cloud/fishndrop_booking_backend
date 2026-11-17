import { NextFunction, Request, Response } from "express";
import { getFrontendBaseUrl } from "../utils/siteUrl";
import Booking from "../models/Booking";
import GuestPass, { generateGuestPassCode, generateGuestQrToken } from "../models/GuestPass";
import logger from "../config/logger";
import { sendGHLGuestPassIssuedEvent, sendGHLGuestPassCancelledEvent } from "../integrations/ghl";
import jwt from "jsonwebtoken";
import User from "../models/User";
import { storeImage } from "../utils/flyer.utils";
import MarketplaceBooking from "../models/MarketplaceBooking";
import {
  MARKETPLACE_INVITABLE,
  ensureInvitationToken,
  findPartyById,
  findPartyByToken,
  partyForPass,
  partyFromMarketplace,
  partyFromTropica
} from "../services/party.service";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";



/**
 * Invites (and guest QR passes) only work once the payment is VERIFIED. A Zelle screenshot alone isn't enough —
 * the booking stays "not confirmed" until the team verifies the transfer.
 */
const isInvitable = (b: any): boolean =>
  !!b &&
  b.bookingType === "private_event" &&
  b.status !== "cancelled" &&
  (b.status === "confirmed" || ["deposit_paid", "paid"].includes(b.paymentStatus));

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
 * Works for Tropica private events and paid partner-venue bookings alike.
 */
export const getInvitationDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = sanitizeString(req.params.token);
    const party = await findPartyByToken(token);

    if (!party) {
      res.status(404).json({ success: false, message: "Invitation not found or invalid link" });
      return;
    }
    if (!party.invitable) {
      res.status(410).json({
        success: false,
        code: "INVITE_INACTIVE",
        message: party.cancelled ? "This event was cancelled." : "This invitation isn't active yet. Please check back soon."
      });
      return;
    }

    const registered = await GuestPass.countDocuments({ booking: party._id, status: activeStatuses });
    const viewerId = optionalUserId(req);
    const myPass = viewerId ? await GuestPass.findOne({ booking: party._id, user: viewerId }) : null;
    const isHost = !!viewerId && String(party.user) === viewerId;

    res.status(200).json({
      success: true,
      invitation: {
        hostName: firstName(party.customerName),
        occasion: party.occasion,
        eventTitle: party.eventTitle,
        flyerUrl: party.flyerUrl,
        date: party.date,
        startTime: party.startTime,
        endTime: party.endTime,
        durationHours: party.durationHours,
        venueName: party.venueName,
        venueAddress: party.venueAddress,
        capacity: party.capacity,
        registered,
        spotsRemaining: Math.max(0, party.capacity - registered),
        isCapacityFull: registered >= party.capacity,
        requireHostApproval: party.requireHostApproval,
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

    const party = await findPartyByToken(token);
    if (!party) {
      res.status(404).json({ success: false, message: "Invitation not found" });
      return;
    }
    if (!party.invitable) {
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

    const fullMessage = `The guest list is full (${party.capacity} guests). Please contact ${firstName(party.customerName)}.`;
    const existingPass = await GuestPass.findOne({
      booking: party._id,
      $or: [{ user: guest._id }, { guestPhone: guest.phone }]
    });
    if (existingPass && existingPass.status === "cancelled") {
      const activeCount = await GuestPass.countDocuments({ booking: party._id, status: activeStatuses });
      if (activeCount >= party.capacity) {
        res.status(403).json({ success: false, code: "CAPACITY_REACHED", message: fullMessage });
        return;
      }
      existingPass.user = guest._id as any;
      existingPass.guestName = guestName;
      existingPass.status = party.requireHostApproval ? "pending_approval" : "approved";
      existingPass.qrCodeToken = generateGuestQrToken();
      existingPass.joinedAt = new Date();
      existingPass.cancelledAt = undefined;
      await existingPass.save();
      logger.info(`Guest ${guestName} re-joined ${party.kind} booking #${party._id} with pass ${existingPass.passCode}`);
      if (party.kind === "tropica") void sendGHLGuestPassIssuedEvent(existingPass, party.doc);
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

    const activePassCount = await GuestPass.countDocuments({ booking: party._id, status: activeStatuses });
    if (activePassCount >= party.capacity) {
      res.status(403).json({ success: false, code: "CAPACITY_REACHED", message: fullMessage });
      return;
    }

    const passStatus = party.requireHostApproval ? "pending_approval" : "approved";
    const pass = await GuestPass.create({
      booking: party._id,
      bookingModel: party.model,
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

    logger.info(`Issued guest pass ${pass.passCode} to ${guestName} for ${party.kind} booking #${party._id}`);
    if (party.kind === "tropica") void sendGHLGuestPassIssuedEvent(pass, party.doc);

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
    const party = await findPartyByToken(token);
    if (!party) {
      res.status(404).json({ success: false, message: "Invitation not found" });
      return;
    }

    const me = await User.findById(req.user._id).select("phone isPhoneVerified").lean();
    const or: any[] = [{ user: req.user._id }];
    if (me?.phone && me.isPhoneVerified) or.push({ guestPhone: me.phone });
    const pass = await GuestPass.findOne({ booking: party._id, $or: or, status: activeStatuses });
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

    const active = await GuestPass.countDocuments({ booking: party._id, status: activeStatuses });
    const spotsRemaining = Math.max(0, party.capacity - active);
    logger.info(`Guest ${updated.guestName} cancelled pass ${updated.passCode} for booking #${party._id} (not attending)`);
    if (party.kind === "tropica") void sendGHLGuestPassCancelledEvent(updated, party.doc, spotsRemaining);

    res.status(200).json({
      success: true,
      message: `You're off the guest list. ${firstName(party.customerName)} has been notified.`,
      pass: passPublic(updated)
    });
  } catch (error: any) {
    next(new Error(`Failed to cancel your spot: ${error.message}`));
  }
};

/**
 * GET /api/invitations/booking/:bookingId/guests
 * Host views registered guests and attendance (Tropica or partner-venue booking).
 */
export const getBookingGuestPasses = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const party = await findPartyById(sanitizeString(req.params.bookingId));
    if (!party) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    // Allow the host, or Tropica admin / staff
    const isOwner = String(party.user) === req.user._id.toString();
    const isAdmin = ["admin", "owner", "staff"].includes(req.user.role);
    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    const token = await ensureInvitationToken(party);
    const guestPasses = await GuestPass.find({ booking: party._id }).sort({ createdAt: -1 });

    const checkedInCount = guestPasses.filter((g) => g.checkedIn && g.status !== "removed").length;
    const approvedCount = guestPasses.filter((g) => g.status === "approved").length;

    res.status(200).json({
      success: true,
      inviteLink: `${getFrontendBaseUrl()}/invite/${token}`,
      invitationToken: token,
      requireHostApproval: party.requireHostApproval,
      capacityLimit: party.capacity,
      invitesActive: party.invitable,
      event: {
        kind: party.kind,
        date: party.date,
        startTime: party.startTime,
        endTime: party.endTime,
        occasion: party.occasion,
        hostName: firstName(party.customerName),
        eventTitle: party.eventTitle,
        flyerUrl: party.flyerUrl,
        venueName: party.venueName,
        venueAddress: party.venueAddress,
        // Partner-venue bookings: show the host where their payment stands
        payment:
          party.kind === "marketplace"
            ? {
                status: party.doc.status,
                bookingNumber: party.doc.bookingNumber,
                total: party.doc.customerPrice,
                paid: party.doc.amountPaid,
                remaining: party.doc.remainingAmount
              }
            : undefined,
        // Tropica bookings paid by Zelle: the host sees "not confirmed — verifying your Zelle" until staff verify it
        zelle:
          party.kind === "tropica" && party.doc.paymentMethod === "zelle" && !party.invitable && party.doc.status !== "cancelled"
            ? {
                state: ["mismatched", "manual_review"].includes(party.doc.zelleVerificationStatus) ? "review" : "verifying",
                amount: party.doc.depositAmount || party.doc.totalAmount || 0
              }
            : undefined
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
 * PATCH /api/invitations/booking/:bookingId/details   (host, or venue staff)
 * Host names their party and uploads / replaces / removes its flyer.
 * Body: eventTitle (""=use default), flyerUrl (data URL to upload, https URL to keep, "" to remove)
 */
export const updateCelebrationDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const party = await findPartyById(sanitizeString(req.params.bookingId));
    if (!party) {
      res.status(404).json({ success: false, message: "Celebration not found" });
      return;
    }
    const isOwner = String(party.user) === req.user._id.toString();
    const isStaff = ["admin", "owner", "staff"].includes(req.user.role);
    if (!isOwner && !isStaff) {
      res.status(403).json({ success: false, message: "Only the host can edit this celebration" });
      return;
    }

    const doc = party.doc;
    if (req.body.eventTitle !== undefined) {
      const title = sanitizeString(req.body.eventTitle);
      if (title.length > 80) {
        res.status(400).json({ success: false, message: "Event name can be at most 80 characters" });
        return;
      }
      doc.eventTitle = title || undefined;
    }
    if (req.body.flyerUrl !== undefined) {
      try {
        doc.flyerUrl = (await storeImage(req.body.flyerUrl, "tropica_celebration_flyers")) || undefined;
      } catch (err: any) {
        res.status(400).json({ success: false, message: `We couldn't upload the flyer (${err.message}). Please choose it again.` });
        return;
      }
    }

    await doc.save();
    logger.info(`Celebration #${party._id} details updated by ${req.user.name || req.user._id}`);
    res.status(200).json({
      success: true,
      message: "Event details saved",
      event: { eventTitle: doc.eventTitle || "", flyerUrl: doc.flyerUrl || "" }
    });
  } catch (error: any) {
    next(new Error(`Failed to update celebration: ${error.message}`));
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
    const party = await partyForPass(pass);
    if (!pass || !party) {
      res.status(404).json({ success: false, message: "Guest pass not found" });
      return;
    }

    const isOwner = String(party.user) === req.user._id.toString();
    const isAdmin = ["admin", "owner", "staff"].includes(req.user.role);
    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    if (pass.status === "cancelled") {
      res.status(409).json({ success: false, message: "This guest cancelled. They're not attending." });
      return;
    }

    // Adding a removed / rejected guest back takes a spot, so respect the paid guest count
    if (status === "approved" && !["approved", "pending_approval"].includes(pass.status)) {
      const active = await GuestPass.countDocuments({ booking: party._id, status: activeStatuses });
      if (active >= party.capacity) {
        res.status(403).json({ success: false, code: "CAPACITY_REACHED", message: `The guest list is full (${party.capacity} guests).` });
        return;
      }
      pass.removedAt = undefined;
    }

    pass.status = status;
    await pass.save();

    res.status(200).json({ success: true, message: `Pass ${status} successfully`, pass });
  } catch (error: any) {
    next(new Error(`Failed to update pass: ${error.message}`));
  }
};

/**
 * DELETE /api/invitations/passes/:passId
 * Host (or venue staff) removes a guest from the list, even after they checked in. Their QR stops working right away
 * (the token is rotated, so the old pass link no longer opens) and the spot frees up.
 * The record is kept as "removed" so the same person can't simply rejoin from the invite link.
 */
export const removeGuestPass = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const pass = await GuestPass.findById(sanitizeString(req.params.passId)).populate("booking");
    const party = await partyForPass(pass);
    if (!pass || !party) {
      res.status(404).json({ success: false, message: "Guest pass not found" });
      return;
    }
    const isOwner = String(party.user) === req.user._id.toString();
    const isStaff = ["admin", "owner", "staff"].includes(req.user.role);
    if (!isOwner && !isStaff) {
      res.status(403).json({ success: false, message: "Only the host can remove guests" });
      return;
    }
    if (!["approved", "pending_approval"].includes(pass.status)) {
      res.status(409).json({ success: false, message: "This guest isn't on the list anymore." });
      return;
    }

    // Atomic: a door scan at the same moment either admits first or sees the pass as removed
    const updated = await GuestPass.findOneAndUpdate(
      { _id: pass._id, status: { $in: ["approved", "pending_approval"] } },
      { $set: { status: "removed", removedAt: new Date(), qrCodeToken: generateGuestQrToken() } },
      { returnDocument: "after" }
    );
    if (!updated) {
      res.status(409).json({ success: false, message: "This guest just changed. Please refresh." });
      return;
    }

    logger.info(`Guest ${updated.guestName} (${updated.passCode}) removed from booking #${party._id} by ${req.user.name || req.user._id}`);
    res.status(200).json({ success: true, message: `${updated.guestName} was removed. Their QR pass no longer works.`, pass: updated });
  } catch (error: any) {
    next(new Error(`Failed to remove guest: ${error.message}`));
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
    const party = await partyForPass(pass);

    if (!pass || !party) {
      res.status(404).json({ success: false, message: "Pass not found" });
      return;
    }

    const occasion = party.occasion.replace(/_/g, " ");
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
          title: party.eventTitle || `${firstName(party.customerName)}'s ${occasion}`,
          flyerUrl: party.flyerUrl,
          occasion,
          hostName: party.customerName,
          date: party.date,
          startTime: party.startTime,
          endTime: party.endTime,
          venueName: party.venueName,
          venueAddress: party.venueAddress,
          cancelled: party.cancelled
        }
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch guest pass: ${error.message}`));
  }
};

const guestCounts = async (ids: any[]) => {
  const counts = await GuestPass.aggregate([
    { $match: { booking: { $in: ids } } },
    {
      $group: {
        _id: "$booking",
        registered: { $sum: { $cond: [{ $in: ["$status", ["approved", "pending_approval"]] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending_approval"] }, 1, 0] } },
        checkedIn: { $sum: { $cond: [{ $and: ["$checkedIn", { $ne: ["$status", "removed"] }] }, 1, 0] } }
      }
    }
  ]);
  return new Map(counts.map((c: any) => [String(c._id), c]));
};

/**
 * GET /api/invitations/my/celebrations
 * The signed-in host's private Tropica events and paid partner-venue bookings,
 * with guest-list and attendance counts.
 */
export const getMyCelebrations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const [bookings, partner] = await Promise.all([
      Booking.find({ user: req.user._id, bookingType: "private_event", status: { $ne: "cancelled" } })
        .select("bookingDate bookingTime eventEndTime durationHours partySize occasion status paymentStatus paymentMethod zelleProofUrl zelleVerificationStatus eventTitle flyerUrl customerName user bookingType")
        .lean(),
      MarketplaceBooking.find({ user: req.user._id, status: { $in: MARKETPLACE_INVITABLE } })
        .populate("venue", "name address flyerUrl")
        .lean()
    ]);

    const parties = [...bookings.map(partyFromTropica), ...partner.map((m) => partyFromMarketplace(m))];
    const byId = await guestCounts(parties.map((p) => p._id));

    const celebrations = parties
      .map((p) => {
        const c = byId.get(String(p._id)) || { registered: 0, pending: 0, checkedIn: 0 };
        const b: any = p.doc;
        return {
          _id: p._id,
          kind: p.kind,
          date: p.date,
          startTime: p.startTime,
          endTime: p.endTime,
          durationHours: p.durationHours,
          occasion: p.occasion,
          eventTitle: p.eventTitle,
          flyerUrl: p.flyerUrl,
          venueName: p.venueName,
          capacity: p.capacity,
          registered: c.registered,
          pendingApproval: c.pending,
          checkedIn: c.checkedIn,
          invitesActive: p.invitable,
          paymentLabel:
            p.kind === "marketplace"
              ? b.status === "deposit_paid"
                ? "Deposit paid"
                : "Confirmed"
              : b.status === "confirmed" || ["deposit_paid", "paid"].includes(b.paymentStatus)
              ? "Confirmed"
              : b.paymentMethod === "zelle" && b.zelleProofUrl
              ? "Zelle verifying"
              : "Awaiting payment"
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.status(200).json({ success: true, celebrations });
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

    const passes = await GuestPass.find({ $or: or, status: { $nin: ["rejected", "cancelled", "removed"] } })
      .populate(
        "booking",
        // Tropica Booking fields + partner MarketplaceBooking fields (each model ignores the other's)
        "customerName occasion bookingDate bookingTime eventEndTime durationHours status paymentStatus paymentMethod zelleProofUrl bookingType invitationToken user eventTitle flyerUrl partySize date startTime endTime guests venue venueName"
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const invites = [];
    for (const p of passes as any[]) {
      if (!p.booking || String(p.booking.user) === String(req.user._id)) continue;
      const party = await partyForPass(p);
      if (!party || party.cancelled) continue;
      invites.push({
        _id: p._id,
        hostName: firstName(party.customerName),
        occasion: party.occasion,
        eventTitle: party.eventTitle,
        flyerUrl: party.flyerUrl,
        date: party.date,
        startTime: party.startTime,
        endTime: party.endTime,
        venueName: party.venueName,
        venueAddress: party.venueAddress,
        inviteToken: party.invitationToken,
        passCode: p.passCode,
        qrCodeToken: p.qrCodeToken,
        status: p.status,
        checkedIn: p.checkedIn,
        cancelDeadline: cancelDeadline(p),
        canCancel: canGuestCancel(p)
      });
    }

    res.status(200).json({ success: true, invites });
  } catch (error: any) {
    next(new Error(`Failed to load your invitations: ${error.message}`));
  }
};

/** Today's calendar date in New York, as the UTC-midnight Date bookings are stored with. */
const venueToday = (): Date => {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(`${ymd}T00:00:00.000Z`);
};

/**
 * GET /api/admin/celebrations?when=today|upcoming|past|all&q=   (admin / owner / staff)
 * Every private venue celebration with guest-list and door check-in numbers.
 */
export const getAdminCelebrations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const when = sanitizeString(req.query.when) || "upcoming";
    const q = sanitizeString(req.query.q);
    const today = venueToday();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    const filter: any = { bookingType: "private_event", status: { $ne: "cancelled" } };
    if (when === "today") filter.bookingDate = { $gte: today, $lt: tomorrow };
    else if (when === "upcoming") filter.bookingDate = { $gte: today };
    else if (when === "past") filter.bookingDate = { $lt: today };
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      filter.$or = [{ customerName: rx }, { customerEmail: rx }, { customerPhone: rx }, { occasion: rx }];
    }

    const bookings = await Booking.find(filter)
      .select("customerName customerPhone customerEmail bookingDate bookingTime eventEndTime durationHours partySize occasion status paymentStatus eventTitle flyerUrl")
      .sort({ bookingDate: when === "past" ? -1 : 1, bookingTime: 1 })
      .limit(200)
      .lean();

    const ids = bookings.map((b) => b._id);
    const counts = await GuestPass.aggregate([
      { $match: { booking: { $in: ids } } },
      {
        $group: {
          _id: "$booking",
          registered: { $sum: { $cond: [{ $in: ["$status", ["approved", "pending_approval"]] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending_approval"] }, 1, 0] } },
          checkedIn: { $sum: { $cond: [{ $and: ["$checkedIn", { $ne: ["$status", "removed"] }] }, 1, 0] } },
          lastCheckInAt: { $max: { $cond: [{ $ne: ["$status", "removed"] }, "$checkedInAt", null] } }
        }
      }
    ]);
    const byId = new Map(counts.map((c: any) => [String(c._id), c]));

    const celebrations = bookings.map((b: any) => {
      const c = byId.get(String(b._id)) || { registered: 0, pending: 0, checkedIn: 0, lastCheckInAt: null };
      return {
        _id: b._id,
        hostName: b.customerName,
        hostPhone: b.customerPhone,
        hostEmail: b.customerEmail,
        date: b.bookingDate,
        startTime: b.bookingTime,
        endTime: b.eventEndTime || "",
        occasion: b.occasion || "celebration",
        eventTitle: b.eventTitle || "",
        flyerUrl: b.flyerUrl || "",
        status: b.status,
        paymentStatus: b.paymentStatus,
        capacity: b.partySize || 0,
        registered: c.registered,
        pendingApproval: c.pending,
        checkedIn: c.checkedIn,
        lastCheckInAt: c.lastCheckInAt
      };
    });

    res.status(200).json({
      success: true,
      celebrations,
      totals: {
        parties: celebrations.length,
        capacity: celebrations.reduce((n, c) => n + c.capacity, 0),
        registered: celebrations.reduce((n, c) => n + c.registered, 0),
        checkedIn: celebrations.reduce((n, c) => n + c.checkedIn, 0)
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to load celebrations: ${error.message}`));
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
    const arrived = passes.filter((p) => p.checkedIn && p.status !== "removed");
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

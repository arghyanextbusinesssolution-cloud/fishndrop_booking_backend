import { NextFunction, Request, Response } from "express";
import Booking from "../../models/Booking";
import SlotLock from "../../models/SlotLock";
import { sanitizeString } from "../../utils/time.utils";
import { sendGHLCancelEvent } from "../../utils/ghl.utils";

export const cancelBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.params.id);
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const isOwner = booking.user.toString() === req.user?.id;
    const isAdmin = req.user?.role === "admin";
    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    if (booking.status === "cancelled") {
      res.status(400).json({ success: false, message: "Booking already cancelled" });
      return;
    }

    await Booking.findByIdAndUpdate(booking._id, { $set: { status: "cancelled" } });
    
    if (booking.bookingType === "private_event") {
      await SlotLock.deleteMany({ eventId: booking._id });
    }

    void sendGHLCancelEvent(booking, "User/Admin requested cancellation");

    res.status(200).json({ success: true, message: "Booking cancelled successfully" });
  } catch (error) {
    next(new Error("Booking cancellation failed"));
  }
};

export const cancelUnpaidBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.body.bookingId || req.params.id);
    if (!bookingId) {
      res.status(400).json({ success: false, message: "bookingId is required" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    // Only cancel if payment is pending_payment and not already confirmed
    if (booking.paymentStatus === "pending_payment" && booking.status !== "confirmed") {
      booking.status = "cancelled";
      await booking.save();

      await SlotLock.deleteMany({ eventId: booking._id });

      res.status(200).json({ success: true, message: "Unpaid booking draft cancelled and slot released" });
      return;
    }

    res.status(400).json({ success: false, message: "Booking is already paid or confirmed" });
  } catch (error) {
    next(new Error("Failed to cancel unpaid booking draft"));
  }
};


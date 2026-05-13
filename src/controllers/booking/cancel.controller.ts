import { NextFunction, Request, Response } from "express";
import Booking from "../../models/Booking";
import SlotLock from "../../models/SlotLock";
import { sanitizeString } from "../../utils/time.utils";

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

    res.status(200).json({ success: true, message: "Booking cancelled successfully" });
  } catch (error) {
    next(new Error("Booking cancellation failed"));
  }
};

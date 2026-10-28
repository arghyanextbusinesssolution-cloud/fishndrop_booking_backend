import { NextFunction, Request, Response } from "express";
import Booking from "../../models/Booking";
import SlotLock from "../../models/SlotLock";
import Table from "../../models/Table";
import { sanitizeString, buildDayRange } from "../../utils/time.utils";
import { sendGHLRescheduleEvent, calculateEventTimes } from "../../utils/ghl.utils";
import logger from "../../config/logger";
import * as BookingService from "../../services/booking";

export const rescheduleBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.params.id);
    const newDate = sanitizeString(req.body.bookingDate || req.body.newDate);
    const newTime = sanitizeString(req.body.bookingTime || req.body.newTime);
    const newDurationHours = Number(req.body.durationHours) || undefined;
    const reason = sanitizeString(req.body.reason || "Customer requested reschedule");

    if (!newDate || !newTime) {
      res.status(400).json({ success: false, message: "New booking date and time are required" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const isOwner = booking.user?.toString() === req.user?.id;
    const isAdmin = req.user?.role === "admin" || req.user?.role === "owner";
    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, message: "Not authorized to reschedule this booking" });
      return;
    }

    const previousBookingDate = booking.bookingDate
      ? booking.bookingDate instanceof Date
        ? booking.bookingDate.toISOString().split("T")[0]
        : String(booking.bookingDate).split("T")[0]
      : "";
    const previousBookingTime = booking.bookingTime;

    const duration = newDurationHours || booking.durationHours || (booking.bookingType === "private_event" ? 5 : 2);

    // If private event, verify availability and adjust slot locks
    if (booking.bookingType === "private_event") {
      const { slots } = await BookingService.getPrivateEventAvailability(newDate, duration);
      const isSlotAvailable = slots.some((s: any) => s.time === newTime && s.available);
      
      // If admin, we allow override if desired, but check for warning
      if (!isSlotAvailable && !isAdmin) {
        res.status(400).json({
          success: false,
          message: "The requested date and time slot is not available for a private event."
        });
        return;
      }

      // Release previous locks
      await SlotLock.deleteMany({ eventId: booking._id });

      // Lock new slot using service
      const { parsedDate } = buildDayRange(newDate);
      await BookingService.createSlotLocksForPrivateEvent(booking._id, parsedDate, newTime, duration);
    }

    // Calculate new event end time
    const { eventEndTime } = calculateEventTimes(newDate, newTime, duration);

    // Update booking record
    booking.previousBookingDate = booking.bookingDate;
    booking.previousBookingTime = previousBookingTime;
    booking.bookingDate = new Date(newDate);
    booking.bookingTime = newTime;
    booking.durationHours = duration;
    booking.eventEndTime = eventEndTime;
    booking.rescheduledAt = new Date();
    booking.rescheduleCount = (booking.rescheduleCount || 0) + 1;
    if (booking.status === "cancelled") {
      booking.status = "confirmed";
    }

    await booking.save();

    logger.info(
      `[Reschedule] Booking #${booking._id} rescheduled from ${previousBookingDate} ${previousBookingTime} to ${newDate} ${newTime}`
    );

    // Send Webhook to GHL
    void sendGHLRescheduleEvent(booking, {
      previousBookingDate,
      previousBookingTime
    });

    res.status(200).json({
      success: true,
      message: "Booking rescheduled successfully. Updated schedule transmitted to GHL.",
      booking: {
        _id: booking._id,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        eventEndTime: booking.eventEndTime,
        durationHours: booking.durationHours,
        status: booking.status,
        rescheduledAt: booking.rescheduledAt,
        previousBookingDate,
        previousBookingTime
      }
    });
  } catch (error: any) {
    logger.error("[Reschedule Error]", { error: error.message });
    next(new Error(`Reschedule failed: ${error.message}`));
  }
};

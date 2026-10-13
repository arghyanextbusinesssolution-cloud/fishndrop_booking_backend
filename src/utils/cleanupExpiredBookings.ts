import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import logger from "../config/logger";

export const PENDING_HOLD_TIMEOUT_MINUTES = 15;

/**
 * Auto-cleanup function that finds unpaid pending bookings created more than 15 minutes ago.
 * Cancels the booking and deletes any associated SlotLock records to release held time slots.
 */
export const cleanupExpiredPendingBookings = async (): Promise<number> => {
  try {
    const cutoff = new Date(Date.now() - PENDING_HOLD_TIMEOUT_MINUTES * 60 * 1000);

    const expiredBookings = await Booking.find({
      status: "pending",
      paymentStatus: "pending_payment",
      createdAt: { $lt: cutoff },
      $or: [
        { paymentMethod: "card" },
        { paymentMethod: "zelle", zelleProofUrl: { $in: ["", null] }, zelleVerificationStatus: "none" },
        { zelleVerificationStatus: { $exists: false } }
      ]
    }).select("_id bookingType customerEmail");

    if (expiredBookings.length === 0) return 0;

    const expiredIds = expiredBookings.map((b) => b._id);
    logger.info(`[Auto-Cleanup] Cleaning up ${expiredIds.length} unpaid pending draft booking(s) older than ${PENDING_HOLD_TIMEOUT_MINUTES}m.`);

    // Remove slot locks created for these expired bookings
    await SlotLock.deleteMany({ eventId: { $in: expiredIds } });

    // Mark expired bookings as cancelled
    await Booking.updateMany(
      { _id: { $in: expiredIds } },
      { $set: { status: "cancelled" } }
    );

    return expiredIds.length;
  } catch (error) {
    logger.error("[Auto-Cleanup Error] Failed to cleanup expired pending bookings:", error);
    return 0;
  }
};

import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import logger from "../config/logger";

export const PENDING_HOLD_TIMEOUT_MINUTES = 15;
/** After the Zelle screenshot is submitted, GHL has this long to verify before the slot reopens. */
export const ZELLE_VERIFY_TIMEOUT_MINUTES = 15;

/** Zelle deposits with a screenshot that GHL didn't verify in time → cancel + free the slot. */
const releaseUnverifiedZelle = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - ZELLE_VERIFY_TIMEOUT_MINUTES * 60 * 1000);
  const stale = await Booking.find({
    status: "pending",
    paymentStatus: "pending_payment",
    paymentMethod: "zelle",
    zelleProofUrl: { $nin: ["", null] },
    zelleVerificationStatus: { $in: ["pending_ghl_verification", "mismatched", "manual_review"] },
    $or: [
      { zelleUploadedAt: { $lt: cutoff } },
      { zelleUploadedAt: { $exists: false }, createdAt: { $lt: cutoff } }
    ]
  }).select("_id customerName");
  if (stale.length === 0) return 0;

  const ids = stale.map((b) => b._id);
  await SlotLock.deleteMany({ eventId: { $in: ids } });
  await Booking.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        status: "cancelled",
        zelleReleasedAt: new Date(),
        zelleNotes: `Slot released: GHL did not verify the Zelle payment within ${ZELLE_VERIFY_TIMEOUT_MINUTES} minutes of the screenshot.`
      }
    }
  );
  logger.warn(
    `[Auto-Cleanup] Released ${ids.length} Zelle booking(s) not verified by GHL within ${ZELLE_VERIFY_TIMEOUT_MINUTES}m: ` +
      stale.map((b) => `${String(b._id).slice(-6)} (${b.customerName})`).join(", ")
  );
  return ids.length;
};

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
        // Zelle with no screenshot submitted (any verification status, including older drafts
        // saved as "pending_ghl_verification" before the screenshot rule)
        { paymentMethod: "zelle", zelleProofUrl: { $in: ["", null] } },
        { zelleVerificationStatus: { $exists: false } }
      ]
    }).select("_id bookingType customerEmail");

    const releasedZelle = await releaseUnverifiedZelle();
    if (expiredBookings.length === 0) return releasedZelle;

    const expiredIds = expiredBookings.map((b) => b._id);
    logger.info(`[Auto-Cleanup] Cleaning up ${expiredIds.length} unpaid pending draft booking(s) older than ${PENDING_HOLD_TIMEOUT_MINUTES}m.`);

    // Remove slot locks created for these expired bookings
    await SlotLock.deleteMany({ eventId: { $in: expiredIds } });

    // Mark expired bookings as cancelled
    await Booking.updateMany(
      { _id: { $in: expiredIds } },
      { $set: { status: "cancelled" } }
    );

    return expiredIds.length + releasedZelle;
  } catch (error) {
    logger.error("[Auto-Cleanup Error] Failed to cleanup expired pending bookings:", error);
    return 0;
  }
};

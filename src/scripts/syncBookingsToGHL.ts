/**
 * One-off backfill: sends every upcoming completed booking to the GHL "booking sync" webhook,
 * then one venue-availability snapshot, so GHL's AI knows about bookings made before the
 * automatic sync went live.
 *
 *   npm run sync-ghl            → send
 *   npm run sync-ghl -- --dry   → only print what would be sent
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/db";
import Booking from "../models/Booking";
import { sendGHLBookingSyncEvent, buildAiBookingSummary } from "../integrations/ghl/triggers/booking/bookingSync.trigger";
import { sendGHLAvailabilityEvent, buildAvailabilitySnapshot } from "../integrations/ghl/triggers/availability/availabilityUpdated.trigger";

dotenv.config();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const dry = process.argv.includes("--dry");
  await connectDB();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const bookings = await Booking.find({
    bookingDate: { $gte: today },
    status: { $ne: "cancelled" },
    $or: [{ status: "confirmed" }, { paymentStatus: { $in: ["deposit_paid", "paid"] } }]
  }).sort({ bookingDate: 1 });

  console.log(`${bookings.length} upcoming completed booking(s)${dry ? " (dry run)" : ""}`);
  for (const [i, b] of bookings.entries()) {
    console.log(`  ${i + 1}. #${String(b._id).slice(-6).toUpperCase()} ${buildAiBookingSummary(b).slice(0, 140)}…`);
    if (!dry) {
      await sendGHLBookingSyncEvent(b, { changeType: "updated", changedFields: ["backfill"] });
      await sleep(1000); // stay well under GHL webhook rate limits
    }
  }

  if (dry) {
    console.log("\nAvailability:\n" + (await buildAvailabilitySnapshot()).aiAvailabilitySummary);
  } else {
    await sendGHLAvailabilityEvent("backfill");
    console.log("Availability snapshot sent.");
  }
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Backfill failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

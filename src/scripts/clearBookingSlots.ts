import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/db";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import DailyTableLock from "../models/DailyTableLock";
import Table from "../models/Table";
import Coupon from "../models/Coupon";

dotenv.config();

const clearBookingSlots = async (): Promise<void> => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is missing in environment variables");
    }

    console.log("Connecting to MongoDB...");
    await connectDB();

    console.log("\nFetching current count of records...");
    const bookingCount = await Booking.countDocuments();
    const slotLockCount = await SlotLock.countDocuments();
    const dailyTableLockCount = await DailyTableLock.countDocuments();
    const lockedTablesCount = await Table.countDocuments({ isAvailable: false });

    console.log(`- Existing Bookings: ${bookingCount}`);
    console.log(`- Locked Time Slots: ${slotLockCount}`);
    console.log(`- Locked Daily Tables: ${dailyTableLockCount}`);
    console.log(`- Disabled Tables: ${lockedTablesCount}`);

    console.log("\nDeleting all bookings and slot/table locks...");

    const deleteBookingsRes = await Booking.deleteMany({});
    console.log(`✓ Deleted ${deleteBookingsRes.deletedCount} bookings.`);

    const deleteSlotLocksRes = await SlotLock.deleteMany({});
    console.log(`✓ Deleted ${deleteSlotLocksRes.deletedCount} locked time slots.`);

    const deleteDailyTableLocksRes = await DailyTableLock.deleteMany({});
    console.log(`✓ Deleted ${deleteDailyTableLocksRes.deletedCount} daily table locks.`);

    const updateTablesRes = await Table.updateMany({}, { isAvailable: true });
    console.log(`✓ Re-enabled ${updateTablesRes.modifiedCount} disabled tables.`);

    const updateCouponsRes = await Coupon.updateMany({}, { usageCount: 0 });
    console.log(`✓ Reset usage count for ${updateCouponsRes.modifiedCount} coupons.`);

    console.log("\n SUCCESS: All booking slots are now completely free and unreserved!");

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error(" Error clearing booking slots:", error);
    try {
      await mongoose.connection.close();
    } catch {}
    process.exit(1);
  }
};

void clearBookingSlots();

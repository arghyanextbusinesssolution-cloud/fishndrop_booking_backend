import mongoose from "mongoose";
import Booking from "../../models/Booking";
import SlotLock from "../../models/SlotLock";
import Table from "../../models/Table";
import assignTables from "../../utils/tableAssigner";
import { isOverlapping, buildDayRange, TIME_SLOTS } from "../../utils/time.utils";

export interface BookingPayload {
  userId: mongoose.Types.ObjectId;
  partySize: number;
  bookingDate: string;
  bookingTime: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  notes: string;
  occasion: string;
  cakeDetails?: string;
  cakePrice?: number;
  customCakeDetails?: any;
  allowSplit?: boolean;
  couponUsed?: mongoose.Types.ObjectId;
  couponCode?: string;
  promoterName?: string;
  discountType?: "percentage" | "fixed";
  discountValue?: number;
}

export const reserveTablesAndCreateBooking = async (payload: BookingPayload) => {
  const { parsedDate, dayStart, dayEnd } = buildDayRange(payload.bookingDate);

  const existingSlotLock = await SlotLock.findOne({
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    bookingTime: payload.bookingTime,
    isLocked: true
  });

  if (existingSlotLock) {
    return { error: "This slot is blocked by admin. Please choose another time." };
  }

  const occupiedBookings = await Booking.find({
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    status: { $in: ["confirmed", "pending"] }
  }).select("tables bookingTime bookingType durationHours");

  const blockedTableIds = occupiedBookings
    .filter((b) => {
      const bDuration = b.bookingType === "private_event" ? (b.durationHours || 1) * 60 : 120;
      return isOverlapping(b.bookingTime, bDuration, payload.bookingTime, 120);
    })
    .flatMap((booking) => booking.tables.map((tableId) => tableId.toString()));

  const assignment = await assignTables(payload.partySize, payload.bookingDate, blockedTableIds, payload.allowSplit);
  if (assignment.error) {
    return { error: assignment.error };
  }

  const originalAmount = assignment.totalAmount + (payload.cakePrice || 0);
  let finalAmount = originalAmount;
  let discountApplied = 0;

  if (payload.discountType && payload.discountValue !== undefined) {
    if (payload.discountType === "percentage") {
      discountApplied = (originalAmount * payload.discountValue) / 100;
    } else {
      discountApplied = payload.discountValue;
    }
    finalAmount = Math.max(0, originalAmount - discountApplied);
  }

  const booking = await Booking.create({
    user: payload.userId,
    tables: assignment.tables.map((table) => table._id),
    partySize: payload.partySize,
    customerName: payload.customerName,
    customerEmail: payload.customerEmail,
    customerPhone: payload.customerPhone,
    notes: payload.notes,
    occasion: payload.occasion,
    cakeDetails: payload.cakeDetails,
    customCakeDetails: payload.customCakeDetails,
    cakePrice: payload.cakePrice || 0,
    totalAmount: finalAmount,
    complimentaryDrinks: assignment.complimentaryDrinks,
    bookingDate: parsedDate,
    bookingTime: payload.bookingTime,
    status: "pending",
    depositAmount: finalAmount,
    remainingAmount: 0,
    remainingPaymentStatus: "paid",
    couponUsed: payload.couponUsed,
    couponCode: payload.couponCode,
    promoterName: payload.promoterName,
    discountApplied,
    originalAmount,
    finalAmount
  });

  return { booking };
};

export const getStandardAvailability = async (date: string, partySize: number, allowSplit: boolean) => {
  const { dayStart, dayEnd } = buildDayRange(date);

  // Adjust range by -6 hours to catch bookings saved in local midnight (e.g. India +5:30)
  const adjustedStart = new Date(dayStart.getTime() - 6 * 60 * 60 * 1000);

  console.log(`[Availability Check] Date: ${date}, Query Range: ${adjustedStart.toISOString()} - ${dayEnd.toISOString()}`);

  const [allTables, slotLocks, bookingsForDay] = await Promise.all([
    Table.find().sort({ tableNumber: 1 }),
    SlotLock.find({ bookingDate: { $gte: adjustedStart, $lte: dayEnd }, isLocked: true }),
    Booking.find({
      bookingDate: { $gte: adjustedStart, $lte: dayEnd },
      status: { $in: ["confirmed", "pending"] }
    }).select("tables bookingTime bookingType durationHours")
  ]);

  console.log(`[Availability Check] Found ${bookingsForDay.length} bookings for this day.`);
  if (bookingsForDay.length > 0) {
    bookingsForDay.forEach(b => console.log(` - Booking: ${b.bookingTime}, Type: ${b.bookingType}, Duration: ${b.durationHours}h`));
  }

  const slots = await Promise.all(
    TIME_SLOTS.map(async (timeSlot) => {
      const locked = slotLocks.find((lock) => lock.bookingTime === timeSlot);
      if (locked) {
        return {
          slot: timeSlot,
          isAvailable: false,
          message: locked.reason || "Blocked until admin unlocks",
          assignedTableIds: [],
          bookedTableIds: []
        };
      }

      const bookedTableIds = bookingsForDay
        .filter((b) => {
          const bDuration = b.bookingType === "private_event" ? (b.durationHours || 1) * 60 : 120;
          return isOverlapping(b.bookingTime, bDuration, timeSlot, 120);
        })
        .flatMap((booking) => booking.tables.map((tableId) => tableId.toString()));

      const assignment = await assignTables(partySize, date, bookedTableIds, allowSplit);

      let assignedNote = "";
      if (!assignment.error && assignment.tables.length > 0) {
        const twoSeaters = assignment.tables.filter(t => t.capacity === 2).length;
        const fourSeaters = assignment.tables.filter(t => t.capacity === 4).length;
        if (fourSeaters === 1 && twoSeaters === 0) assignedNote = "1 x 4-Seater Table";
        else if (fourSeaters === 0 && twoSeaters === 2) assignedNote = "2 x 2-Seater Combination";
        else if (fourSeaters === 1 && twoSeaters === 1) assignedNote = "1 x 4-Seater + 1 x 2-Seater Combination";
        else if (fourSeaters === 0 && twoSeaters === 3) assignedNote = "3 x 2-Seater Combination";
        else if (fourSeaters === 2 && twoSeaters === 0) assignedNote = "2 x 4-Seater Arrangement";
        else if (fourSeaters === 1 && twoSeaters === 2) assignedNote = "1 x 4-Seater + 2 x 2-Seater Combination";
        else if (fourSeaters === 0 && twoSeaters === 4) assignedNote = "4 x 2-Seater Combination";
        else if (fourSeaters === 0 && twoSeaters === 1) assignedNote = "1 x 2-Seater Table";
        else assignedNote = "Custom Arrangement";
      }

      return {
        slot: timeSlot,
        isAvailable: !assignment.error,
        message: assignment.error || "Available",
        assignedTableIds: assignment.tables.map((table) => table._id.toString()),
        assignedNote,
        bookedTableIds
      };
    })
  );

  return { slots, allTables };
};

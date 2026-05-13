import Booking from "../../models/Booking";
import SlotLock from "../../models/SlotLock";
import Table from "../../models/Table";
import { isOverlapping, buildDayRange, timeToMinutes, TIME_SLOTS } from "../../utils/time.utils";

export const getPrivateEventAvailability = async (date: string, duration: number) => {
  const { dayStart, dayEnd } = buildDayRange(date);

  const [allTables, slotLocks, bookingsForDay] = await Promise.all([
    Table.find(),
    SlotLock.find({ bookingDate: { $gte: dayStart, $lte: dayEnd }, isLocked: true }),
    Booking.find({ bookingDate: { $gte: dayStart, $lte: dayEnd }, status: "confirmed" })
  ]);

  const totalCapacity = allTables.reduce((sum, table) => sum + table.capacity, 0);

  const HOURLY_SLOTS = [];
  for (let i = 10; i <= 22; i++) {
    HOURLY_SLOTS.push(`${i}:00`);
  }

  const isSlotOccupied = (slotTime: string) => {
    const hasStandardBooking = bookingsForDay.some(b => {
      if (b.bookingType === "private_event") return false;
      return isOverlapping(b.bookingTime, 120, slotTime, 60);
    });
    if (hasStandardBooking) return true;

    const hasPrivateEvent = bookingsForDay.some(b => {
      if (b.bookingType !== "private_event") return false;
      const pDurationMins = (b.durationHours || 1) * 60;
      return isOverlapping(b.bookingTime, pDurationMins, slotTime, 60);
    });
    if (hasPrivateEvent) return true;

    return slotLocks.some(lock => lock.bookingTime === slotTime);
  };

  const slots = HOURLY_SLOTS.map(timeSlot => {
    let blockAvailable = true;
    const startMins = timeToMinutes(timeSlot);
    const endMins = startMins + duration * 60;
    
    if (endMins > 23 * 60) {
      blockAvailable = false;
    } else {
      for (let m = startMins; m < endMins; m += 60) {
        const checkTime = `${Math.floor(m / 60)}:00`;
        if (isSlotOccupied(checkTime)) {
          blockAvailable = false;
          break;
        }
      }
    }

    return {
      slot: timeSlot,
      isAvailable: blockAvailable,
      message: blockAvailable ? "Available" : "Venue partially or fully booked"
    };
  });

  return { slots, totalCapacity };
};

export const createSlotLocksForPrivateEvent = async (bookingId: any, bookingDate: Date, bookingTime: string, durationHours: number) => {
  const eventDurationMins = durationHours * 60;
  
  for (const timeSlot of TIME_SLOTS) {
    if (isOverlapping(bookingTime, eventDurationMins, timeSlot, 120)) {
       await SlotLock.create({
         bookingDate,
         bookingTime: timeSlot,
         isLocked: true,
         reason: "Private Event Buyout",
         eventId: bookingId
       });
    }
  }
};

import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import Table from "../models/Table";
import User from "../models/User";
import assignTables from "../utils/tableAssigner";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

const TIME_SLOTS = ["18:00", "19:00", "20:00", "21:00"];

const buildDayRange = (inputDate: string) => {
  const parsedDate = new Date(inputDate);
  const dayStart = new Date(parsedDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(parsedDate);
  dayEnd.setHours(23, 59, 59, 999);
  return { parsedDate, dayStart, dayEnd };
};

const reserveTablesAndCreateBooking = async (
  payload: {
    userId: mongoose.Types.ObjectId;
    partySize: number;
    bookingDate: string;
    bookingTime: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    notes: string;
    occasion: "birthday" | "anniversary" | "graduation" | "other";
    cakeDetails: string;
    cakePrice: number;
  }
) => {
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
    bookingTime: payload.bookingTime,
    status: "confirmed"
  }).select("tables");
  const blockedTableIds = occupiedBookings.flatMap((booking) => booking.tables.map((tableId) => tableId.toString()));
  const assignment = await assignTables(payload.partySize, blockedTableIds);
  if (assignment.error) {
    return { error: assignment.error };
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
    cakePrice: payload.cakePrice,
    totalAmount: assignment.totalAmount + payload.cakePrice,
    complimentaryDrinks: assignment.complimentaryDrinks,
    bookingDate: parsedDate,
    bookingTime: payload.bookingTime
  });

  return { booking };
};

export const createBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const partySize = Number(req.body.partySize);
    const bookingDate = sanitizeString(req.body.bookingDate);
    const bookingTime = sanitizeString(req.body.bookingTime);
    const customerName = sanitizeString(req.body.customerName);
    const customerEmail = sanitizeString(req.body.customerEmail).toLowerCase();
    const customerPhone = sanitizeString(req.body.customerPhone);
    const notes = sanitizeString(req.body.notes);
    const occasion = sanitizeString(req.body.occasion) as "birthday" | "anniversary" | "graduation" | "other";
    const cakeDetails = sanitizeString(req.body.cakeDetails);
    const cakePrice = Number(req.body.cakePrice || 0);

    const result = await reserveTablesAndCreateBooking({
      userId: req.user!._id,
      partySize,
      bookingDate,
      bookingTime,
      customerName,
      customerEmail,
      customerPhone,
      notes,
      occasion,
      cakeDetails,
      cakePrice
    });
    if (result.error || !result.booking) {
      res.status(400).json({ success: false, message: result.error || "Booking creation failed" });
      return;
    }
    res.status(201).json({ success: true, booking: result.booking });
  } catch (error) {
    next(new Error("Booking creation failed"));
  }
};

export const createBookingWithAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = sanitizeString(req.body.customerName);
    const email = sanitizeString(req.body.customerEmail).toLowerCase();
    const phone = sanitizeString(req.body.customerPhone);
    const password = sanitizeString(req.body.password);

    const partySize = Number(req.body.partySize);
    const bookingDate = sanitizeString(req.body.bookingDate);
    const bookingTime = sanitizeString(req.body.bookingTime);
    const notes = sanitizeString(req.body.notes);
    const occasion = sanitizeString(req.body.occasion) as "birthday" | "anniversary" | "graduation" | "other";
    const cakeDetails = sanitizeString(req.body.cakeDetails);
    const cakePrice = Number(req.body.cakePrice || 0);

    let user = await User.findOne({ email }).select("+password");
    let accountCreated = false;
    if (!user) {
      const rawPassword = password || `Auto@${Math.floor(100000 + Math.random() * 900000)}`;
      user = await User.create({ name, email, password: rawPassword, phone, role: "user" });
      user = await User.findById(user._id).select("+password");
      accountCreated = true;
    } else {
      if (!password || !(await user.comparePassword(password))) {
        res.status(409).json({ success: false, message: "Account exists. Please login with password to continue." });
        return;
      }
      // Update phone if missing
      if (!user.phone && phone) {
        user.phone = phone;
        await user.save();
      }
    }

    const result = await reserveTablesAndCreateBooking({
      userId: user!._id,
      partySize,
      bookingDate,
      bookingTime,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      notes,
      occasion,
      cakeDetails,
      cakePrice
    });
    if (result.error || !result.booking) {
      res.status(400).json({ success: false, message: result.error || "Booking creation failed" });
      return;
    }

    const token = jwt.sign({ id: user!._id }, process.env.JWT_SECRET as string, { algorithm: "HS256", expiresIn: "7d" });
    res.status(201).json({
      success: true,
      booking: result.booking,
      accountCreated,
      token,
      user: { id: user!._id, name: user!.name, email: user!.email, phone: user!.phone, role: user!.role }
    });
  } catch (error) {
    next(new Error("Booking with account creation failed"));
  }
};

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
    res.status(200).json({ success: true, message: "Booking cancelled successfully" });
  } catch (error) {
    next(new Error("Booking cancellation failed"));
  }
};

export const getUserBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 10;
    const skip = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      Booking.find({ user: req.user?._id }).populate("tables").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments({ user: req.user?._id })
    ]);

    res.status(200).json({
      success: true,
      bookings,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    next(new Error("Failed to fetch user bookings"));
  }
};

export const getBookingById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.params.id);
    const booking = await Booking.findById(bookingId).populate("tables");

    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (booking.user.toString() !== req.user?._id.toString()) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    res.status(200).json({ success: true, booking });
  } catch (error) {
    next(new Error("Failed to fetch booking"));
  }
};

export const getAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const date = sanitizeString(req.query.date);
    const slot = sanitizeString(req.query.slot);
    const parsedPartySize = Number(req.query.partySize);
    const partySize = Number.isFinite(parsedPartySize) && parsedPartySize >= 2 ? parsedPartySize : 2;
    const parsedDate = new Date(date);

    if (!date || Number.isNaN(parsedDate.getTime())) {
      res.status(400).json({ success: false, message: "Valid date is required" });
      return;
    }

    const dayStart = new Date(parsedDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(parsedDate);
    dayEnd.setHours(23, 59, 59, 999);

    const [allTables, lockedTables] = await Promise.all([
      Table.find().sort({ tableNumber: 1 }),
      Table.find({ isAvailable: false }).select("_id")
    ]);
    const lockedTableIds = lockedTables.map((table) => table._id.toString());

    const slotLocks = await SlotLock.find({
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      isLocked: true
    });

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
        const occupied = await Booking.find({
          bookingDate: { $gte: dayStart, $lte: dayEnd },
          bookingTime: timeSlot,
          status: "confirmed"
        }).select("tables");
        const bookedTableIds = occupied.flatMap((booking) => booking.tables.map((tableId) => tableId.toString()));
        const assignment = await assignTables(partySize, bookedTableIds);
        return {
          slot: timeSlot,
          isAvailable: !assignment.error,
          message: assignment.error || "Available",
          assignedTableIds: assignment.tables.map((table) => table._id.toString()),
          bookedTableIds
        };
      })
    );

    const slotData = slot ? slots.find((slotItem) => slotItem.slot === slot) : undefined;
    const selectedTableIds = slotData?.assignedTableIds || [];
    const bookedForSelectedSlot = slotData?.bookedTableIds || [];

    const layout = allTables.map((table) => {
      const id = table._id.toString();
      let state: "available" | "booked" | "selected" | "locked" = "available";
      if (lockedTableIds.includes(id)) state = "locked";
      else if (bookedForSelectedSlot.includes(id)) state = "booked";
      else if (selectedTableIds.includes(id)) state = "selected";
      return {
        _id: id,
        tableNumber: table.tableNumber,
        capacity: table.capacity,
        state
      };
    });

    res.status(200).json({
      success: true,
      date,
      partySize,
      slots: slots.map(({ bookedTableIds, assignedTableIds, ...rest }) => rest),
      layout
    });
  } catch (error) {
    next(new Error("Failed to fetch availability"));
  }
};

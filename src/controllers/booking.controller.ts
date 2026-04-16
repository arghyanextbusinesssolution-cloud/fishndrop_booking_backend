import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import Table from "../models/Table";
import User from "../models/User";
import assignTables from "../utils/tableAssigner";
import { sendPaymentEmails } from "../utils/email.utils";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

const TIME_SLOTS = ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"];

const buildDayRange = (inputDate: string) => {
  const parsedDate = new Date(inputDate);
  // Ensure we are working with UTC midnight to match MongoDB storage
  const dayStart = new Date(parsedDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(parsedDate);
  dayEnd.setUTCHours(23, 59, 59, 999);
  return { parsedDate, dayStart, dayEnd };
};

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const isOverlapping = (timeA: string, timeB: string, durationMinutes: number = 120): boolean => {
  const minsA = timeToMinutes(timeA);
  const minsB = timeToMinutes(timeB);
  return Math.abs(minsA - minsB) < durationMinutes;
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
    customCakeDetails?: any;
    allowSplit?: boolean;
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
    status: "confirmed"
  }).select("tables bookingTime");

  const blockedTableIds = occupiedBookings
    .filter((b) => isOverlapping(b.bookingTime, payload.bookingTime))
    .flatMap((booking) => booking.tables.map((tableId) => tableId.toString()));

  const assignment = await assignTables(payload.partySize, payload.bookingDate, blockedTableIds, payload.allowSplit);
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
    customCakeDetails: payload.customCakeDetails,
    cakePrice: payload.cakePrice,
    totalAmount: assignment.totalAmount + payload.cakePrice,
    complimentaryDrinks: assignment.complimentaryDrinks,
    bookingDate: parsedDate,
    bookingTime: payload.bookingTime,
    paymentStatus: "paid"
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
    const customCakeDetails = req.body.customCakeDetails;
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
      customCakeDetails,
      cakePrice,
      allowSplit: req.body.allowSplit === true
    });
    if (result.error || !result.booking) {
      res.status(400).json({ success: false, message: result.error || "Booking creation failed" });
      return;
    }

    void sendPaymentEmails(result.booking as any);

    res.status(201).json({ success: true, booking: result.booking });
  } catch (error: any) {
    console.error("[Booking Create Error]:", error);
    next(new Error(`Booking creation failed: ${error.message}`));
  }
};

export const createBookingWithAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    let name = sanitizeString(req.body.customerName);
    let email = sanitizeString(req.body.customerEmail).toLowerCase();
    let phone = sanitizeString(req.body.customerPhone);
    const password = sanitizeString(req.body.password);

    const partySize = Number(req.body.partySize);
    const bookingDate = sanitizeString(req.body.bookingDate);
    const bookingTime = sanitizeString(req.body.bookingTime);
    const notes = sanitizeString(req.body.notes);
    const occasion = sanitizeString(req.body.occasion) as "birthday" | "anniversary" | "graduation" | "other";
    const cakeDetails = sanitizeString(req.body.cakeDetails);
    const customCakeDetails = req.body.customCakeDetails;
    const cakePrice = Number(req.body.cakePrice || 0);
    const allowSplit = req.body.allowSplit === true;

    // Check if user is already authenticated (via token)
    let authenticatedUser = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
        authenticatedUser = await User.findById(decoded.id).select("+password");
      } catch (err) {
        // Token invalid, ignore and proceed as guest
      }
    }

    let user;
    let accountCreated = false;

    if (authenticatedUser) {
      // If the token is there, force fill like the website is logged in
      user = authenticatedUser;
      name = user.name;
      email = user.email;
      phone = user.phone || phone;
    } else {
      user = await User.findOne({ email }).select("+password");
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
      }
    }

    // Update phone if missing
    if (user && !user.phone && phone) {
      user.phone = phone;
      await user.save();
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
      customCakeDetails,
      cakePrice,
      allowSplit
    });
    if (result.error || !result.booking) {
      res.status(400).json({ success: false, message: result.error || "Booking creation failed" });
      return;
    }

    void sendPaymentEmails(result.booking as any);

    const token = jwt.sign({ id: user!._id }, process.env.JWT_SECRET as string, { algorithm: "HS256", expiresIn: "7d" });
    res.status(201).json({
      success: true,
      booking: result.booking,
      accountCreated,
      token,
      user: { id: user!._id, name: user!.name, email: user!.email, phone: user!.phone, role: user!.role }
    });
  } catch (error: any) {
    console.error("[Booking Create Error]:", error);
    next(new Error(`Booking with account creation failed: ${error.message}`));
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
    const allowSplit = req.query.allowSplit === "true";
    const parsedPartySize = Number(req.query.partySize);
    const partySize = Number.isFinite(parsedPartySize) && parsedPartySize >= 2 ? parsedPartySize : 2;
    
    const { dayStart, dayEnd } = buildDayRange(date);

    const [allTables, lockedTables] = await Promise.all([
      Table.find().sort({ tableNumber: 1 }),
      Table.find({ isAvailable: false }).select("_id")
    ]);
    const lockedTableIds = lockedTables.map((table) => table._id.toString());

    const slotLocks = await SlotLock.find({
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      isLocked: true
    });

    const bookingsForDay = await Booking.find({
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      status: "confirmed"
    }).select("tables bookingTime");

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
          .filter((b) => isOverlapping(b.bookingTime, timeSlot))
          .flatMap((booking) => booking.tables.map((tableId) => tableId.toString()));

        const assignment = await assignTables(partySize, date, bookedTableIds, allowSplit);
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

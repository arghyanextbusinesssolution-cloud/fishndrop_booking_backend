import { NextFunction, Request, Response } from "express";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import Table from "../models/Table";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

export const seedTables = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const existingCount = await Table.countDocuments();
    if (existingCount > 0) {
      res.status(400).json({ success: false, message: "Tables already seeded" });
      return;
    }

    const tables = [
      { tableNumber: 1, capacity: 2 },
      { tableNumber: 2, capacity: 2 },
      { tableNumber: 3, capacity: 2 },
      { tableNumber: 4, capacity: 4 },
      { tableNumber: 5, capacity: 4 },
      { tableNumber: 6, capacity: 4 }
    ];

    await Table.insertMany(tables);
    res.status(201).json({ success: true, message: "Tables seeded successfully" });
  } catch (error) {
    next(new Error("Table seeding failed"));
  }
};

export const getAllTables = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tables = await Table.find().sort({ tableNumber: 1 });
    res.status(200).json({ success: true, tables, counts: {
      twoSeaters: tables.filter((table) => table.capacity === 2).length,
      fourSeaters: tables.filter((table) => table.capacity === 4).length
    } });
  } catch (error) {
    next(new Error("Failed to fetch tables"));
  }
};

export const getAllBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 10;
    const status = sanitizeString(req.query.status);
    const skip = (page - 1) * limit;
    const filter = status ? { status } : {};

    const [bookings, total] = await Promise.all([
      Booking.find(filter).populate("user", "name email").populate("tables").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      bookings,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    next(new Error("Failed to fetch bookings"));
  }
};

export const getTableStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [total, available, twoSeatersAvailable, fourSeatersAvailable] = await Promise.all([
      Table.countDocuments(),
      Table.countDocuments({ isAvailable: true }),
      Table.countDocuments({ isAvailable: true, capacity: 2 }),
      Table.countDocuments({ isAvailable: true, capacity: 4 })
    ]);

    res.status(200).json({
      success: true,
      stats: {
        total,
        available,
        booked: total - available,
        twoSeatersAvailable,
        fourSeatersAvailable
      }
    });
  } catch (error) {
    next(new Error("Failed to fetch table stats"));
  }
};

export const updateTableCounts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const requestedTwoSeaters = Number(req.body.twoSeaters);
    const requestedFourSeaters = Number(req.body.fourSeaters);

    if (!Number.isInteger(requestedTwoSeaters) || requestedTwoSeaters < 0 || !Number.isInteger(requestedFourSeaters) || requestedFourSeaters < 0) {
      res.status(400).json({ success: false, message: "Table counts must be non-negative integers" });
      return;
    }

    const [allTables, maxTable] = await Promise.all([
      Table.find().sort({ tableNumber: 1 }),
      Table.findOne().sort({ tableNumber: -1 })
    ]);

    const twoTables = allTables.filter((table) => table.capacity === 2);
    const fourTables = allTables.filter((table) => table.capacity === 4);
    const bookedTwo = twoTables.filter((table) => !table.isAvailable).length;
    const bookedFour = fourTables.filter((table) => !table.isAvailable).length;

    if (requestedTwoSeaters < bookedTwo || requestedFourSeaters < bookedFour) {
      res.status(400).json({
        success: false,
        message: "Cannot reduce below currently locked/booked tables. Unlock tables first."
      });
      return;
    }

    const ops: Promise<unknown>[] = [];
    let nextTableNumber = (maxTable?.tableNumber || 0) + 1;

    const twoDiff = requestedTwoSeaters - twoTables.length;
    if (twoDiff > 0) {
      const toCreate = Array.from({ length: twoDiff }, () => ({ tableNumber: nextTableNumber++, capacity: 2 as const }));
      ops.push(Table.insertMany(toCreate));
    } else if (twoDiff < 0) {
      const toDelete = twoTables.filter((table) => table.isAvailable).sort((a, b) => b.tableNumber - a.tableNumber).slice(0, Math.abs(twoDiff));
      ops.push(Table.deleteMany({ _id: { $in: toDelete.map((table) => table._id) } }));
    }

    const fourDiff = requestedFourSeaters - fourTables.length;
    if (fourDiff > 0) {
      const toCreate = Array.from({ length: fourDiff }, () => ({ tableNumber: nextTableNumber++, capacity: 4 as const }));
      ops.push(Table.insertMany(toCreate));
    } else if (fourDiff < 0) {
      const toDelete = fourTables.filter((table) => table.isAvailable).sort((a, b) => b.tableNumber - a.tableNumber).slice(0, Math.abs(fourDiff));
      ops.push(Table.deleteMany({ _id: { $in: toDelete.map((table) => table._id) } }));
    }

    await Promise.all(ops);
    const updatedTables = await Table.find().sort({ tableNumber: 1 });
    res.status(200).json({
      success: true,
      message: "Table counts updated",
      tables: updatedTables,
      counts: {
        twoSeaters: updatedTables.filter((table) => table.capacity === 2).length,
        fourSeaters: updatedTables.filter((table) => table.capacity === 4).length
      }
    });
  } catch (error) {
    next(new Error("Failed to update table counts"));
  }
};

export const setTableAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tableId = sanitizeString(req.params.id);
    const isAvailable = Boolean(req.body.isAvailable);
    const table = await Table.findByIdAndUpdate(tableId, { $set: { isAvailable } }, { new: true });
    if (!table) {
      res.status(404).json({ success: false, message: "Table not found" });
      return;
    }
    res.status(200).json({ success: true, table });
  } catch (error) {
    next(new Error("Failed to update table availability"));
  }
};

export const setSlotLock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingDateRaw = sanitizeString(req.body.bookingDate);
    const bookingTime = sanitizeString(req.body.bookingTime);
    const reason = sanitizeString(req.body.reason) || "Blocked until admin unlocks";
    const isLocked = Boolean(req.body.isLocked);
    const bookingDate = new Date(bookingDateRaw);
    if (Number.isNaN(bookingDate.getTime()) || !bookingTime) {
      res.status(400).json({ success: false, message: "bookingDate and bookingTime are required" });
      return;
    }

    const dayStart = new Date(bookingDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(bookingDate);
    dayEnd.setHours(23, 59, 59, 999);

    const existing = await SlotLock.findOne({
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      bookingTime
    });

    if (isLocked) {
      if (existing) {
        existing.isLocked = true;
        existing.reason = reason;
        await existing.save();
      } else {
        await SlotLock.create({ bookingDate, bookingTime, isLocked: true, reason });
      }
      res.status(200).json({ success: true, message: "Slot locked successfully" });
      return;
    }

    if (existing) {
      await SlotLock.findByIdAndDelete(existing._id);
    }
    res.status(200).json({ success: true, message: "Slot unlocked successfully" });
  } catch (error) {
    next(new Error("Failed to update slot lock"));
  }
};

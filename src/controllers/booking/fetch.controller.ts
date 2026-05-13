import { NextFunction, Request, Response } from "express";
import Booking from "../../models/Booking";
import Table from "../../models/Table";
import { sanitizeString } from "../../utils/time.utils";

export const getUserBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 10;
    const status = req.query.status as string;
    const type = req.query.type as string;
    const skip = (page - 1) * limit;

    const query: any = { user: req.user?._id };
    if (status && status !== "all") query.status = status;
    if (type && type !== "all") query.bookingType = type;

    const [bookings, total] = await Promise.all([
      Booking.find(query).populate("tables").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments(query)
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

    if (booking.user.toString() !== req.user?._id.toString() && req.user?.role !== "admin") {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    res.status(200).json({ success: true, booking });
  } catch (error) {
    next(new Error("Failed to fetch booking"));
  }
};

export const getVenueCapacity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const allTables = await Table.find();
    const totalCapacity = allTables.reduce((sum, table) => sum + table.capacity, 0);
    res.status(200).json({ success: true, totalCapacity });
  } catch (error) {
    next(new Error("Failed to fetch venue capacity"));
  }
};

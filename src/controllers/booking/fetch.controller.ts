import { NextFunction, Request, Response } from "express";
import Booking from "../../models/Booking";
import Table from "../../models/Table";
import { sanitizeString } from "../../utils/time.utils";
import { cleanupExpiredPendingBookings } from "../../utils/cleanupExpiredBookings";
import { formatToE164 } from "../../services/ghlOtp.service";

export const getUserBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await cleanupExpiredPendingBookings();
    const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 10;
    const status = req.query.status as string;
    const type = req.query.type as string;
    const skip = (page - 1) * limit;

    const userPhone = req.user?.phone;
    const cleanUserDigits = userPhone ? userPhone.replace(/\D/g, "") : "";
    const last10 = cleanUserDigits.slice(-10);

    const userFilters: any[] = [{ user: req.user?._id }];
    if (userPhone) {
      userFilters.push({ customerPhone: userPhone });
      userFilters.push({ customerPhone: formatToE164(userPhone) });
      userFilters.push({ customerPhone: cleanUserDigits });
      if (last10.length >= 7) {
        userFilters.push({ customerPhone: { $regex: last10 + "$" } });
      }
    }
    if (req.user?.email && !req.user.email.includes("@fishndrop.com")) {
      userFilters.push({ customerEmail: req.user.email.toLowerCase() });
    }

    const query: any = { $or: userFilters };
    if (status && status !== "all") query.status = status;
    if (type && type !== "all") query.bookingType = type;

    const [bookings, total] = await Promise.all([
      Booking.find(query).populate("tables").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments(query)
    ]);

    // Ensure any bookings matched by phone are linked to this user's account
    if (req.user?._id) {
      const unlinkedBookings = bookings.filter(b => b.user?.toString() !== req.user?._id.toString());
      if (unlinkedBookings.length > 0) {
        await Booking.updateMany(
          { _id: { $in: unlinkedBookings.map(b => b._id) } },
          { $set: { user: req.user._id } }
        ).catch(() => {});
      }
    }

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

    const userCleanPhone = req.user?.phone?.replace(/\D/g, "");
    const bookingCleanPhone = booking.customerPhone?.replace(/\D/g, "");

    const isOwner =
      booking.user?.toString() === req.user?._id.toString() ||
      (userCleanPhone && bookingCleanPhone && userCleanPhone === bookingCleanPhone) ||
      req.user?.role === "admin" ||
      req.user?.role === "owner";

    if (!isOwner) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    res.status(200).json({ success: true, booking });
  } catch (error) {
    next(new Error("Failed to fetch booking"));
  }
};

export const getPublicBookingStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.params.id);
    const booking = await Booking.findById(bookingId).populate("tables").select("-user");

    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    res.status(200).json({
      success: true,
      booking: {
        _id: booking._id,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        partySize: booking.partySize,
        bookingType: booking.bookingType,
        totalAmount: booking.totalAmount,
        depositAmount: booking.depositAmount,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        paymentMethod: booking.paymentMethod,
        zelleProofUrl: booking.zelleProofUrl,
        zelleVerificationStatus: booking.zelleVerificationStatus,
        zelleNotes: booking.zelleNotes,
        createdAt: booking.createdAt
      }
    });
  } catch (error) {
    next(new Error("Failed to fetch public booking status"));
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

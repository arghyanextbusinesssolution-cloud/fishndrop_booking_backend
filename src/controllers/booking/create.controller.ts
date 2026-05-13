import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../../models/User";
import { sendPaymentEmails } from "../../utils/email.utils";
import { sanitizeString } from "../../utils/time.utils";
import * as BookingService from "../../services/booking";

export const createBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const payload: BookingService.BookingPayload = {
      userId: req.user!._id,
      partySize: Number(req.body.partySize),
      bookingDate: sanitizeString(req.body.bookingDate),
      bookingTime: sanitizeString(req.body.bookingTime),
      customerName: sanitizeString(req.body.customerName),
      customerEmail: sanitizeString(req.body.customerEmail).toLowerCase(),
      customerPhone: sanitizeString(req.body.customerPhone),
      notes: sanitizeString(req.body.notes),
      occasion: sanitizeString(req.body.occasion),
      cakeDetails: sanitizeString(req.body.cakeDetails),
      customCakeDetails: req.body.customCakeDetails,
      cakePrice: Number(req.body.cakePrice || 0),
      allowSplit: req.body.allowSplit === true
    };

    const result = await BookingService.reserveTablesAndCreateBooking(payload);
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

    let authenticatedUser = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
        authenticatedUser = await User.findById(decoded.id).select("+password");
      } catch (err) {}
    }

    let user;
    let accountCreated = false;

    if (authenticatedUser) {
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

    if (user && !user.phone && phone) {
      user.phone = phone;
      await user.save();
    }

    const payload: BookingService.BookingPayload = {
      userId: user!._id,
      partySize: Number(req.body.partySize),
      bookingDate: sanitizeString(req.body.bookingDate),
      bookingTime: sanitizeString(req.body.bookingTime),
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      notes: sanitizeString(req.body.notes),
      occasion: sanitizeString(req.body.occasion),
      cakeDetails: sanitizeString(req.body.cakeDetails),
      customCakeDetails: req.body.customCakeDetails,
      cakePrice: Number(req.body.cakePrice || 0),
      allowSplit: req.body.allowSplit === true
    };

    const result = await BookingService.reserveTablesAndCreateBooking(payload);
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
    console.error("[Booking With Account Error]:", error);
    next(new Error(`Booking with account creation failed: ${error.message}`));
  }
};

import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../../models/User";
import Table from "../../models/Table";
import Booking from "../../models/Booking";
import { sendPaymentEmails } from "../../utils/email.utils";
import { sanitizeString, buildDayRange } from "../../utils/time.utils";
import * as BookingService from "../../services/booking";
import Coupon from "../../models/Coupon";

export const getPrivateAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const date = sanitizeString(req.query.date);
    const duration = Number(req.query.duration) || 1;
    const { slots, totalCapacity } = await BookingService.getPrivateEventAvailability(date, duration);

    res.status(200).json({
      success: true,
      totalCapacity,
      slots
    });
  } catch (error) {
    next(new Error("Failed to fetch private availability"));
  }
};

export const createPrivateEventWithAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    let name = sanitizeString(req.body.customerName);
    let email = sanitizeString(req.body.customerEmail).toLowerCase();
    let phone = sanitizeString(req.body.customerPhone);
    const password = sanitizeString(req.body.password);

    const partySize = Number(req.body.partySize);
    const bookingDate = sanitizeString(req.body.bookingDate);
    const bookingTime = sanitizeString(req.body.bookingTime);
    const durationHours = Number(req.body.durationHours) || 1;
    const notes = sanitizeString(req.body.notes);
    const occasion = sanitizeString(req.body.occasion);

    let authenticatedUser = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
        authenticatedUser = await User.findById(decoded.id).select("+password");
      } catch (err) { }
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

    const { parsedDate } = buildDayRange(bookingDate);
    const allTables = await Table.find();
    const totalAmount = durationHours * 125;
    let currentAmount = totalAmount;
    let couponUsed, couponCode, promoterName, discountApplied = 0;

    if (req.body.couponCode) {
      const coupon = await Coupon.findOne({ code: String(req.body.couponCode).toUpperCase(), status: "active" });
      if (coupon && (!coupon.expiryDate || new Date() <= coupon.expiryDate) && (!coupon.usageLimit || coupon.usageCount < coupon.usageLimit)) {
        couponUsed = coupon._id;
        couponCode = coupon.code;
        promoterName = coupon.promoterName;
        discountApplied = coupon.discountType === "percentage" ? (totalAmount * coupon.discountValue) / 100 : coupon.discountValue;
        currentAmount = Math.max(0, totalAmount - discountApplied);
      }
    }

    // Deposit = $200 for private events (or full current amount if < $200)
    let depositAmount = Math.min(currentAmount, 200);
    if (req.body.customDepositAmount) {
      const custom = Number(req.body.customDepositAmount);
      if (!isNaN(custom) && custom >= depositAmount && custom <= currentAmount) {
        depositAmount = custom;
      }
    }
    const remainingAmount = currentAmount - depositAmount;
    const remainingPaymentStatus = remainingAmount === 0 ? "paid" : "unpaid";

    const booking = await Booking.create({
      user: user!._id,
      tables: allTables.map(t => t._id),
      partySize,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      notes,
      occasion,
      totalAmount: currentAmount,
      complimentaryDrinks: partySize * 2,
      bookingDate: parsedDate,
      bookingTime,
      bookingType: "private_event",
      durationHours,
      status: "pending",
      depositAmount,
      remainingAmount,
      remainingPaymentStatus,
      remainingPaymentReminderSent: false,
      couponUsed,
      couponCode,
      promoterName,
      discountApplied,
      originalAmount: totalAmount,
      finalAmount: currentAmount
    });

    await BookingService.createSlotLocksForPrivateEvent(booking._id, parsedDate, bookingTime, durationHours);

    const token = jwt.sign({ id: user!._id }, process.env.JWT_SECRET as string, { algorithm: "HS256", expiresIn: "7d" });

    res.status(201).json({
      success: true,
      booking,
      accountCreated,
      token,
      user: { id: user!._id, name: user!.name, email: user!.email, phone: user!.phone, role: user!.role }
    });
  } catch (error: any) {
    console.error("[Private Event Error]:", error);
    next(new Error(`Private event creation failed: ${error.message}`));
  }
};

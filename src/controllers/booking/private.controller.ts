import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../../models/User";
import Table from "../../models/Table";
import Booking from "../../models/Booking";
import { sendPaymentEmails } from "../../utils/email.utils";
import { sanitizeString, buildDayRange } from "../../utils/time.utils";
import * as BookingService from "../../services/booking";
import Coupon from "../../models/Coupon";
import { sendGHLLeadEvent, sendGHLZellePendingEvent } from "../../utils/ghl.utils";

const LEAD_CONNECTOR_WEBHOOK_URL =
  process.env.LEAD_CONNECTOR_WEBHOOK_URL ||
  "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/bc6da1e0-2155-4d01-a223-318afd60c723";

const sendPrivateBookingLead = async (booking: any, payload: Record<string, any>) => {
  if (!LEAD_CONNECTOR_WEBHOOK_URL) return;

  try {
    await fetch(LEAD_CONNECTOR_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "private_booking",
        bookingId: booking._id?.toString?.() || booking.id,
        bookingType: booking.bookingType,
        bookingStatus: booking.status,
        createdAt: booking.createdAt,
        ...payload
      })
    });
  } catch (error) {
    console.warn("[Lead Connector] Failed to send private booking lead", error);
  }
};

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
    let name = sanitizeString(req.body.customerName || req.body.name);
    let email = sanitizeString(req.body.customerEmail || req.body.email).toLowerCase();
    let phone = sanitizeString(req.body.customerPhone || req.body.phone);
    const password = sanitizeString(req.body.password);

    const partySize = Number(req.body.partySize);
    const bookingDate = sanitizeString(req.body.bookingDate);
    const bookingTime = sanitizeString(req.body.bookingTime);
    const durationHours = Number(req.body.durationHours) || 1;
    const notes = sanitizeString(req.body.notes);
    const occasion = sanitizeString(req.body.occasion);
    const needDj = Boolean(req.body.needDj);
    const needPhotographer = Boolean(req.body.needPhotographer);
    const photographerHours = Math.max(2, Number(req.body.photographerHours) || 2);
    const cateringMenu = sanitizeString(req.body.cateringMenu);

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
      name = name || user.name || "Guest User";
      email = email || user.email || (phone ? `guest_${phone.replace(/\D/g, "")}@fishndrop.com` : `guest_${user._id}@fishndrop.com`);
      phone = phone || user.phone || "";

      let shouldSave = false;
      if (name && (!user.name || user.name === "Guest User")) { user.name = name; shouldSave = true; }
      if (email && !user.email) { user.email = email; shouldSave = true; }
      if (shouldSave) await user.save();
    } else {
      if (phone) {
        user = await User.findOne({ phone });
      }
      if (!user && email) {
        user = await User.findOne({ email });
      }

      const cleanPhoneDigits = phone.replace(/\D/g, "");
      if (!name) name = "Guest User";
      if (!email) {
        email = `guest_${cleanPhoneDigits || Date.now()}@fishndrop.com`;
      }

      if (!user) {
        user = await User.create({ name, email, phone, isPhoneVerified: true, role: "user" });
        accountCreated = true;
      } else {
        if (name && (!user.name || user.name === "Guest User")) user.name = name;
        if (email && !user.email) user.email = email;
        if (phone && !user.phone) user.phone = phone;
        await user.save();
      }
    }

    const { parsedDate } = buildDayRange(bookingDate);
    const allTables = await Table.find();
    const djCost = needDj ? 300 : 0;
    const extraHoursCost = durationHours > 5 ? (durationHours - 5) * 300 : 0;
    const photographerCost = needPhotographer ? 300 + Math.max(0, photographerHours - 2) * 150 : 0;
    const totalAmount = 1500 + extraHoursCost + djCost + photographerCost;
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

    // Deposit = $300 to secure date and time for Tropica October Booking Special
    let minDeposit = Math.min(currentAmount, 300);
    let depositAmount = Math.min(currentAmount, 300);
    if (req.body.customDepositAmount) {
      const custom = Number(req.body.customDepositAmount);
      if (!isNaN(custom) && custom >= minDeposit && custom <= currentAmount) {
        depositAmount = custom;
      }
    }
    const remainingAmount = currentAmount - depositAmount;
    const remainingPaymentStatus = remainingAmount === 0 ? "paid" : "unpaid";

    const isZelle = req.body.paymentMethod === "zelle";
    const zelleProofUrl = sanitizeString(req.body.zelleProofUrl);

    const booking = await Booking.create({
      user: user!._id,
      tables: allTables.map(t => t._id),
      partySize,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      notes,
      occasion,
      needDj,
      needPhotographer,
      photographerHours: needPhotographer ? photographerHours : 0,
      cateringMenu,
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
      finalAmount: currentAmount,
      paymentMethod: isZelle ? "zelle" : "card",
      zelleProofUrl: zelleProofUrl || "",
      zelleVerificationStatus: isZelle ? "pending_ghl_verification" : "none",
      zelleUploadedAt: isZelle && zelleProofUrl ? new Date() : undefined,
      quoteHistory: [
        {
          action: "inquiry_created",
          actor: "user",
          actorName: name,
          cateringMenu,
          notes: notes || "Initial private buyout inquiry submitted",
          createdAt: new Date()
        }
      ]
    });

    await BookingService.createSlotLocksForPrivateEvent(booking._id, parsedDate, bookingTime, durationHours);

    if (isZelle) {
      void sendGHLZellePendingEvent(booking);
    } else {
      void sendGHLLeadEvent(booking);
    }

    await sendPrivateBookingLead(booking, {
      name,
      email,
      phone,
      bookingDate,
      bookingTime,
      partySize,
      durationHours,
      occasion,
      needDj,
      cateringMenu,
      notes,
      depositAmount,
      totalAmount: currentAmount,
      remainingAmount,
      customDepositAmount: req.body.customDepositAmount ? Number(req.body.customDepositAmount) : depositAmount,
      couponApplied: Boolean(couponCode),
      couponCode: couponCode || "",
      couponDiscountAmount: discountApplied,
      couponDetails: couponCode
        ? { code: couponCode, discountAmount: discountApplied, promoterName: promoterName || "" }
        : null,
      bookingDetails: {
        occasion,
        needDj,
        cateringMenu,
        notes,
        partySize,
        durationHours,
        bookingDate,
        bookingTime,
        depositAmount,
        totalAmount: currentAmount,
        remainingAmount,
        customDepositAmount: req.body.customDepositAmount ? Number(req.body.customDepositAmount) : depositAmount,
      },
      accountCreated,
      userId: user!._id?.toString?.() || user!._id
    });

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

export const updateBookingMenu = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.params.id);
    const { cateringMenu, notes } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (cateringMenu !== undefined) {
      booking.cateringMenu = cateringMenu;
    }
    if (notes !== undefined) {
      booking.notes = notes;
    }

    // Extract dish list if formatted like [Dishes: ...]
    let dishesList: string[] = [];
    if (notes) {
      const match = notes.match(/\[Dishes:\s*([^\]]+)\]/i);
      if (match && match[1]) {
        dishesList = match[1].split(",").map((s: string) => s.trim()).filter(Boolean);
      }
    }

    // If booking was already quoted, editing the menu requests a new revised quote
    if (booking.offerPrice) {
      booking.offerStatus = "pending";
    }

    const actorRole = (req as any).user?.role === "admin" ? "admin" : "user";
    const actorName = (req as any).user?.name || booking.customerName || "Customer";

    booking.quoteHistory = booking.quoteHistory || [];
    booking.quoteHistory.push({
      action: "menu_updated",
      actor: actorRole,
      actorName,
      cateringMenu: cateringMenu || booking.cateringMenu,
      dishes: dishesList,
      notes: notes !== undefined ? notes : booking.notes,
      createdAt: new Date()
    });

    await booking.save();
    const updated = await Booking.findById(booking._id).populate("tables");

    res.status(200).json({
      success: true,
      message: "Catering menu and preferences updated successfully",
      booking: updated
    });
  } catch (error: any) {
    next(new Error(`Failed to update booking menu: ${error.message}`));
  }
};

export const respondToQuote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = sanitizeString(req.params.id);
    const { action, notes } = req.body;

    const booking = await Booking.findById(bookingId).populate("tables");
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (!booking.offerPrice && booking.offerStatus !== "offered") {
      res.status(400).json({ success: false, message: "No active quote proposal found for this booking" });
      return;
    }

    booking.quoteHistory = booking.quoteHistory || [];

    if (action === "accept") {
      booking.offerStatus = "accepted";
      booking.foodPaymentStatus = booking.foodPaymentStatus || "unpaid";

      booking.quoteHistory.push({
        action: "quote_accepted",
        actor: "user",
        actorName: booking.customerName || "Customer",
        price: booking.offerPrice,
        notes: notes ? sanitizeString(notes) : "Customer accepted food quote proposal ($" + (booking.offerPrice?.toFixed(2) || "0.00") + "). Food payment pending.",
        createdAt: new Date()
      });
    } else if (action === "reject") {
      booking.offerStatus = "declined";
      booking.quoteHistory.push({
        action: "quote_rejected",
        actor: "user",
        actorName: booking.customerName || "Customer",
        price: booking.offerPrice,
        notes: notes ? sanitizeString(notes) : "Customer declined quoted proposal",
        createdAt: new Date()
      });
    } else {
      res.status(400).json({ success: false, message: "Invalid action. Must be 'accept' or 'reject'" });
      return;
    }

    await booking.save();

    res.status(200).json({
      success: true,
      message: action === "accept" ? "Quote accepted successfully!" : "Quote declined.",
      booking
    });
  } catch (error: any) {
    next(new Error(`Failed to process quote response: ${error.message}`));
  }
};



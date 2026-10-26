import { NextFunction, Request, Response } from "express";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import Table from "../models/Table";
import DailyTableLock from "../models/DailyTableLock";
import User from "../models/User";
import assignTables from "../utils/tableAssigner";
import { buildDayRange, isOverlapping, TIME_SLOTS } from "../utils/time.utils";
import { sendPaymentEmails, sendFullPaymentConfirmationViaEmailJS } from "../utils/email.utils";
import { sendGHLBookingEvent } from "../utils/ghl.utils";
import { cleanupExpiredPendingBookings } from "../utils/cleanupExpiredBookings";
import { sendQuoteViaGHL } from "../services/ghlQuote.service";
import { createSlotLocksForPrivateEvent } from "../services/booking/private.service";
import { formatToE164 } from "../services/ghlOtp.service";

/** Inline restaurant label map so backend does not depend on frontend lib */
const CATERING_LABEL_MAP: Record<string, string> = {
  none: "No Partner Catering (Self-Managed)",
  no_catering: "No Partner Catering (Self-Managed)",
  jamaican_jerk_house: "Jamaican Jerk House",
  east_coast_street_tacos: "East Coast Street Tacos",
  cooklyn_eats: "Cooklyn Eats",
  cooklyneats: "Cooklyn Eats",
  custom_catering: "Custom / Multi-Restaurant Mix",
  custom: "Custom Menu",
  seafood_buffet: "Jamaican Jerk House",
  tropica_signature: "East Coast Street Tacos",
  bbq_grill: "Cooklyn Eats",
  cocktail_canapes: "East Coast Street Tacos",
  vegan_garden: "Cooklyn Eats",
  kids_friendly: "Jamaican Jerk House"
};


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
    const dateQuery = sanitizeString(req.query.date);
    const tables = await Table.find().sort({ tableNumber: 1 });

    let dailyLocks: any[] = [];
    if (dateQuery) {
      const start = new Date(dateQuery);
      start.setHours(0, 0, 0, 0);
      const end = new Date(dateQuery);
      end.setHours(23, 59, 59, 999);
      dailyLocks = await DailyTableLock.find({
        date: { $gte: start, $lte: end }
      });
    }

    const mergedTables = tables.map(table => {
      const lock = dailyLocks.find(l => l.table.toString() === table._id.toString());
      return {
        ...table.toObject(),
        isAvailable: lock ? !lock.isLocked : table.isAvailable
      };
    });

    res.status(200).json({
      success: true,
      tables: mergedTables,
      counts: {
        twoSeaters: mergedTables.filter((table) => table.capacity === 2).length,
        fourSeaters: mergedTables.filter((table) => table.capacity === 4).length
      }
    });
  } catch (error) {
    next(new Error("Failed to fetch tables"));
  }
};

export const getAllBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await cleanupExpiredPendingBookings();
    const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
    const limitRaw = req.query.limit;
    const limit = limitRaw !== undefined ? Number(limitRaw) : 10;
    const status = sanitizeString(req.query.status);
    const dateQuery = sanitizeString(req.query.date);
    const bookingType = sanitizeString(req.query.bookingType || req.query.type);

    const baseFilter: any = {};

    if (bookingType && bookingType !== "all") {
      baseFilter.bookingType = bookingType;
    }

    if (dateQuery) {
      const { dayStart, dayEnd } = buildDayRange(dateQuery);
      const adjustedStart = new Date(dayStart.getTime() - 6 * 60 * 60 * 1000);
      baseFilter.bookingDate = { $gte: adjustedStart, $lte: dayEnd };
    }

    const filter: any = { ...baseFilter };

    if (status === "leads") {
      filter.paymentStatus = "pending_payment";
      filter.status = { $ne: "cancelled" };
    } else if (status === "bookings") {
      filter.paymentStatus = { $in: ["deposit_paid", "paid"] };
      filter.status = { $ne: "cancelled" };
    } else if (status === "cancelled") {
      filter.status = "cancelled";
    } else if (status && status !== "all") {
      filter.status = status;
    }

    let queryExec = Booking.find(filter).populate("user", "name email").populate("tables").sort({ createdAt: -1 });
    if (limit > 0) {
      const skip = (page - 1) * limit;
      queryExec = queryExec.skip(skip).limit(limit);
    }

    const [bookings, total, leadsCount, bookingsCount, cancelledCount, allCount] = await Promise.all([
      queryExec,
      Booking.countDocuments(filter),
      Booking.countDocuments({ ...baseFilter, paymentStatus: "pending_payment", status: { $ne: "cancelled" } }),
      Booking.countDocuments({ ...baseFilter, paymentStatus: { $in: ["deposit_paid", "paid"] }, status: { $ne: "cancelled" } }),
      Booking.countDocuments({ ...baseFilter, status: "cancelled" }),
      Booking.countDocuments(baseFilter)
    ]);

    res.status(200).json({
      success: true,
      bookings,
      total,
      page,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 1,
      counts: {
        all: allCount,
        leads: leadsCount,
        bookings: bookingsCount,
        cancelled: cancelledCount
      }
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
    const dateQuery = sanitizeString(req.body.date);

    if (dateQuery) {
      const date = new Date(dateQuery);
      date.setHours(0, 0, 0, 0);

      if (isAvailable) {
        // Unlocking: Remove daily lock
        await DailyTableLock.findOneAndDelete({ table: tableId, date });
      } else {
        // Locking: Create or update daily lock
        await DailyTableLock.findOneAndUpdate(
          { table: tableId, date },
          { isLocked: true },
          { upsert: true, new: true }
        );
      }
      res.status(200).json({ success: true, message: "Daily availability updated" });
      return;
    }

    // Global toggle if no date provided
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

export const deleteTable = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tableId = sanitizeString(req.params.id);

    // Check if table has any future confirmed bookings
    const futureBookings = await Booking.findOne({
      tables: tableId,
      status: "confirmed",
      bookingDate: { $gte: new Date().setHours(0, 0, 0, 0) }
    });

    if (futureBookings) {
      res.status(400).json({
        success: false,
        message: "Cannot delete table with active future bookings. Cancel the bookings first."
      });
      return;
    }

    const table = await Table.findByIdAndDelete(tableId);
    if (!table) {
      res.status(404).json({ success: false, message: "Table not found" });
      return;
    }

    res.status(200).json({ success: true, message: "Table deleted successfully" });
  } catch (error) {
    next(new Error("Failed to delete table"));
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

/** List all active slot locks */
export const getSlotLocks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const locks = await SlotLock.find({ isLocked: true }).sort({ bookingDate: 1, bookingTime: 1 });
    res.status(200).json({ success: true, locks });
  } catch (error) {
    next(new Error("Failed to fetch slot locks"));
  }
};

/** Return payment summary + recent paid/unpaid bookings */
export const getPaymentSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await cleanupExpiredPendingBookings();
    const [allBookings, paidBookings, unpaidBookings] = await Promise.all([
      Booking.find({ status: "confirmed" }).select("totalAmount paymentStatus"),
      Booking.find({ status: "confirmed", paymentStatus: "paid" }).select("totalAmount"),
      Booking.find({ status: "confirmed", paymentStatus: "pending_payment" }).select("totalAmount"),
    ]);

    const totalRevenue = paidBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
    const pendingRevenue = unpaidBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);

    // Return recent bookings with payment info
    const recentBookings = await Booking.find({ status: "confirmed" })
      .populate("user", "name email")
      .populate("tables")
      .sort({ createdAt: -1 })
      .limit(20);

    res.status(200).json({
      success: true,
      summary: {
        totalRevenue,
        pendingRevenue,
        totalBookings: allBookings.length,
        paidCount: paidBookings.length,
        unpaidCount: unpaidBookings.length,
      },
      recentBookings,
    });


  } catch (error) {
    next(new Error(" Failed to fetch payment summary"));
  }
};

export const deleteBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = req.params.id;
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    if (booking.bookingType === "private_event") {
      await SlotLock.deleteMany({ eventId: booking._id });
    }
    await Booking.findByIdAndDelete(bookingId);
    res.status(200).json({ success: true, message: "Booking deleted successfully" });
  } catch (error) {
    next(new Error("Failed to delete booking"));
  }
};

/** Manually confirm or reject Zelle payment from Admin Panel */
export const verifyAdminZelleBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = req.params.id;
    const { action, notes, proofType } = req.body; // action: "verify" | "reject", proofType?: "deposit" | "balance"

    const booking = await Booking.findById(bookingId).populate("tables");
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const isFoodVerification =
      proofType === "food" ||
      (Boolean(booking.foodZelleProofUrl) && booking.foodPaymentStatus === "pending_verification" && proofType !== "deposit" && proofType !== "balance");

    const isBalanceVerification =
      !isFoodVerification &&
      (proofType === "balance" ||
      (Boolean(booking.remainingZelleProofUrl) && booking.remainingPaymentStatus !== "paid"));

    if (action === "verify") {
      if (isFoodVerification) {
        booking.foodPaymentStatus = "paid";
        booking.foodPaidAt = new Date();
        booking.paymentBreakdown = booking.paymentBreakdown?.map(p =>
          p.paymentType === "food_catering" ? { ...p, status: "verified" as const } : p
        );
        booking.quoteHistory = booking.quoteHistory || [];
        booking.quoteHistory.push({
          action: "quote_accepted",
          actor: "admin",
          actorName: "Tropica Admin",
          price: booking.offerPrice,
          notes: notes || "Food catering Zelle payment manually verified by Administrator",
          createdAt: new Date()
        });
        await booking.save();
      } else if (isBalanceVerification) {
        // Clear remaining balance!
        booking.remainingPaymentStatus = "paid";
        booking.paymentStatus = "paid";
        booking.remainingAmount = 0;
        booking.remainingZelleVerificationStatus = "verified";
        booking.status = "confirmed";
        booking.zelleNotes = notes || "Remaining balance manually verified by Administrator";
        await booking.save();

        void sendFullPaymentConfirmationViaEmailJS(booking);
      } else {
        // Clear deposit
        booking.status = "confirmed";
        booking.paymentStatus = (booking.remainingAmount === 0 || booking.bookingType === "standard") ? "paid" : "deposit_paid";
        if (booking.paymentStatus === "paid") {
          booking.remainingPaymentStatus = "paid";
          booking.remainingAmount = 0;
        }
        booking.zelleVerificationStatus = "verified";
        booking.zelleNotes = notes || "Deposit manually verified by Administrator";
        await booking.save();

        void sendPaymentEmails(booking);
      }

      void sendGHLBookingEvent(booking);

      res.status(200).json({ success: true, message: "Zelle payment manually verified and updated successfully", booking });
    } else {
      if (isFoodVerification) {
        booking.foodPaymentStatus = "unpaid";
        booking.zelleNotes = notes || "Food catering Zelle payment flagged as mismatched by Administrator";
      } else if (isBalanceVerification) {
        booking.remainingZelleVerificationStatus = "mismatched";
        booking.zelleNotes = notes || "Remaining balance Zelle payment flagged as mismatched by Administrator";
      } else {
        booking.status = "pending";
        booking.paymentStatus = "pending_payment";
        booking.zelleVerificationStatus = "mismatched";
        booking.zelleNotes = notes || "Deposit Zelle payment flagged as mismatched by Administrator";
      }
      await booking.save();

      res.status(200).json({ success: true, message: "Zelle payment marked as mismatched", booking });
    }
  } catch (error) {
    next(new Error("Failed to process manual Zelle verification"));
  }
};

/** Set offer price or negotiated quote on customer booking */
export const updateBookingOfferPrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookingId = req.params.id;
    const { offerPrice, negotiationNotes, applyAsTotal, dishQuantities } = req.body;

    const booking = await Booking.findById(bookingId).populate("tables");
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const rawPrice = Number(offerPrice);
    if (isNaN(rawPrice) || rawPrice < 0) {
      res.status(400).json({ success: false, message: "Invalid offer price" });
      return;
    }

    const fee = 50;
    let baseFoodPrice: number;
    let finalCustomerPrice: number;

    if (req.body.alreadyHasMarkup) {
      finalCustomerPrice = rawPrice;
      baseFoodPrice = req.body.basePrice !== undefined ? Number(req.body.basePrice) : Math.max(0, rawPrice - fee);
    } else {
      baseFoodPrice = rawPrice;
      finalCustomerPrice = baseFoodPrice + fee;
    }

    booking.foodBasePrice = baseFoodPrice;
    booking.foodServiceFee = fee;
    booking.offerPrice = finalCustomerPrice;
    booking.offerStatus = "offered";
    booking.foodPaymentStatus = booking.foodPaymentStatus || "unpaid";

    if (negotiationNotes !== undefined) {
      booking.negotiationNotes = sanitizeString(negotiationNotes);
    }

    // Persist dish quantities if provided by admin
    if (dishQuantities && typeof dishQuantities === "object") {
      (booking as any).dishQuantities = dishQuantities;
    }

    booking.quoteHistory = booking.quoteHistory || [];
    booking.quoteHistory.push({
      action: "quote_sent",
      actor: "admin",
      actorName: "Tropica Admin",
      price: finalCustomerPrice,
      notes: negotiationNotes
        ? `${sanitizeString(negotiationNotes)} (Food: $${baseFoodPrice.toFixed(2)} + $${fee.toFixed(2)} Tropica Fee)`
        : `Includes $${fee.toFixed(2)} Tropica fee ($${baseFoodPrice.toFixed(2)} food base)`,
      createdAt: new Date()
    });

    await booking.save();

    // ─── Fire GHL Catering Quote Webhook ───────────────────────────
    try {
      // Parse dishes from booking notes (format: [Dishes: A, B, C])
      let parsedDishes: string[] = [];
      if (booking.notes) {
        const dishesMatch = booking.notes.match(/\[Dishes:\s*([^\]]+)\]/i);
        if (dishesMatch?.[1]) {
          parsedDishes = dishesMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean);
        }
      }

      // Build dishes array with quantities
      let savedQuantities: Record<string, number> = {};
      const bookingQuantities = (booking as any).dishQuantities;
      if (bookingQuantities) {
        if (typeof bookingQuantities.entries === "function") {
          savedQuantities = Object.fromEntries(bookingQuantities.entries());
        } else if (typeof bookingQuantities === "object") {
          savedQuantities = { ...bookingQuantities };
        }
      }
      if (dishQuantities && typeof dishQuantities === "object") {
        savedQuantities = { ...savedQuantities, ...dishQuantities };
      }

      const dishesWithQty = parsedDishes.length > 0
        ? parsedDishes.map((rawName: string) => {
            const qtyMatch =
              rawName.match(/^(.*?)\s*\(?(?:x|\bqty:?)\s*(\d+)(?:\s*(?:platters?|plates?))?\)?$/i) ||
              rawName.match(/^(.*?)\s*\((\d+)\s*(?:platters?|plates?|x)?\)$/i);
            const cleanName = qtyMatch ? qtyMatch[1].trim() : rawName;
            const parsedQty = qtyMatch ? parseInt(qtyMatch[2], 10) : 1;
            const qty = savedQuantities[cleanName] ?? savedQuantities[rawName] ?? parsedQty;
            return { name: cleanName, quantity: qty };
          })
        : Object.entries(savedQuantities).map(([name, qty]) => ({ name, quantity: Number(qty) || 1 }));

      const restaurantName = CATERING_LABEL_MAP[booking.cateringMenu || "none"] || booking.cateringMenu || "Self-Managed";

      // Parse dietary notes if available
      let dietaryNotes = "";
      if (booking.notes) {
        const dietaryMatch = booking.notes.match(/\[Dietary:\s*([^\]]+)\]/i);
        if (dietaryMatch?.[1]) {
          dietaryNotes = dietaryMatch[1].trim();
        }
      }

      // Formatted tables
      const tableStr = Array.isArray(booking.tables)
        ? booking.tables.map((t: any) => (typeof t === "object" ? t.tableNumber || t.name || t._id : String(t))).join(", ")
        : (booking.tables ? String(booking.tables) : "");

      const bookingId = String(booking._id);
      const shortBookingId = bookingId.length >= 6 ? bookingId.slice(-6).toUpperCase() : bookingId;
      const nameParts = (booking.customerName || "").trim().split(/\s+/);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const dishesSummary = dishesWithQty.map((d: any) => `${d.name} (x${d.quantity})`).join(", ");
      const totalDishCount = dishesWithQty.reduce((sum: number, d: any) => sum + (Number(d.quantity) || 1), 0);
      const dateStr = booking.bookingDate
        ? (booking.bookingDate instanceof Date
            ? booking.bookingDate.toISOString().split("T")[0]
            : String(booking.bookingDate).split("T")[0])
        : "";

      await sendQuoteViaGHL({
        event: "quote_sent",
        ghlTag: "Quote Sent",
        action: "quote_sent",
        leadStatus: "booking",
        bookingId,
        booking_id: bookingId,
        shortBookingId: `#${shortBookingId}`,
        customerName: booking.customerName || "",
        customer_name: booking.customerName || "",
        first_name: firstName,
        last_name: lastName,
        customerEmail: booking.customerEmail || "",
        email: booking.customerEmail || "",
        customerPhone: booking.customerPhone || "",
        phone: booking.customerPhone || "",
        bookingDate: dateStr,
        booking_date: dateStr,
        bookingTime: booking.bookingTime || "",
        booking_time: booking.bookingTime || "",
        durationHours: booking.durationHours || 5,
        duration_hours: booking.durationHours || 5,
        partySize: booking.partySize || 1,
        party_size: booking.partySize || 1,
        bookingType: booking.bookingType || "private_event",
        booking_type: booking.bookingType || "private_event",
        occasion: booking.occasion || "",
        venueName: "Tropica / Fish & Drop",
        tables: tableStr,
        tableNumbers: tableStr,
        restaurantName,
        restaurant_name: restaurantName,
        cateringMenu: booking.cateringMenu || "none",
        dishes: dishesWithQty,
        dishesList: dishesSummary,
        dishesSummary,
        dishCount: totalDishCount,
        dietaryNotes,
        notes: booking.notes || "",
        negotiationNotes: negotiationNotes ? sanitizeString(negotiationNotes) : (booking.negotiationNotes || ""),
        quoteNotes: negotiationNotes ? sanitizeString(negotiationNotes) : (booking.negotiationNotes || ""),
        offerPrice: finalCustomerPrice,
        offer_price: finalCustomerPrice,
        quotePrice: finalCustomerPrice,
        quote_price: finalCustomerPrice,
        formattedOfferPrice: `$${finalCustomerPrice.toFixed(2)}`,
        foodBasePrice: baseFoodPrice,
        food_base_price: baseFoodPrice,
        tropicaFee: fee,
        serviceFee: fee,
        totalAmount: Number(booking.totalAmount || 0),
        total_amount: Number(booking.totalAmount || 0),
        depositAmount: Number(booking.depositAmount || 0),
        deposit_amount: Number(booking.depositAmount || 0),
        remainingAmount: Number(booking.remainingAmount || 0),
        remaining_amount: Number(booking.remainingAmount || 0),
        status: booking.status || "confirmed",
        paymentStatus: booking.paymentStatus || "pending_payment",
        offerStatus: "offered",
        foodPaymentStatus: booking.foodPaymentStatus || "unpaid",
        needDj: Boolean(booking.needDj),
        needPhotographer: Boolean(booking.needPhotographer),
        photographerHours: Number(booking.photographerHours || 0),
        complimentaryDrinks: Number(booking.complimentaryDrinks || 0),
        customCakeDetails: booking.customCakeDetails || null,
        cakePrice: Number(booking.cakePrice || 0),
        timestamp: new Date().toISOString()
      });
    } catch (webhookErr: any) {
      // Webhook failure must not roll back the save — just log it
      console.error("[GHL QUOTE WEBHOOK] Non-fatal error:", webhookErr?.message);
    }
    // ──────────────────────────────────────────────────────────────

    res.status(200).json({
      success: true,
      message: "Offer price / quote updated successfully",
      booking
    });
  } catch (error) {
    next(new Error("Failed to update booking offer price"));
  }
};

/**
 * Lookup existing customer by phone number or email (gives instant feedback in admin manual booking)
 */
export const lookupCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const phone = sanitizeString(req.query.phone);
    const email = sanitizeString(req.query.email).toLowerCase();

    if (!phone && !email) {
      res.status(400).json({ success: false, message: "Phone or email required for lookup" });
      return;
    }

    const conditions: any[] = [];
    if (phone) {
      const formattedPhone = formatToE164(phone);
      const cleanDigits = phone.replace(/\D/g, "");
      conditions.push({ phone: formattedPhone }, { phone }, { phone: cleanDigits });
    }
    if (email) {
      conditions.push({ email });
    }

    const user = await User.findOne({ $or: conditions }).select("name email phone role isPhoneVerified");
    if (!user) {
      res.status(200).json({ success: true, exists: false });
      return;
    }

    const pastBookingsCount = await Booking.countDocuments({ user: user._id });

    res.status(200).json({
      success: true,
      exists: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        pastBookingsCount
      }
    });
  } catch (error) {
    next(new Error("Customer lookup failed"));
  }
};

/**
 * Admin Manual Booking Creation:
 * - Creates user account by phone number WITHOUT requiring OTP verification if they don't have one
 * - Blocks the chosen slot and reserved table(s) in the database immediately
 * - Calculates and tracks deposit / paid amount and remaining balance
 * - Supports both standard table reservations and private event buyouts
 */
export const createManualBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const customerPhone = sanitizeString(req.body.customerPhone || req.body.phone);
    if (!customerPhone) {
      res.status(400).json({ success: false, message: "Customer phone number is required" });
      return;
    }

    const customerName = sanitizeString(req.body.customerName || req.body.name) || "Walk-in Guest";
    const customerEmailRaw = sanitizeString(req.body.customerEmail || req.body.email).toLowerCase();
    const formattedPhone = formatToE164(customerPhone);
    const cleanDigits = customerPhone.replace(/\D/g, "");
    const customerEmail = customerEmailRaw || `guest_${cleanDigits || Date.now()}@fishndrop.com`;

    const last10 = cleanDigits.slice(-10);

    // 1. Resolve or Create User Account WITHOUT OTP (Stored with E.164 phone to match OTP login)
    let user = await User.findOne({
      $or: [
        { phone: formattedPhone },
        { phone: customerPhone },
        { phone: cleanDigits },
        ...(last10.length >= 7 ? [{ phone: { $regex: last10 + "$" } }] : []),
        ...(customerEmailRaw ? [{ email: customerEmailRaw }] : [])
      ]
    });

    let accountCreated = false;
    if (!user) {
      user = await User.create({
        name: customerName,
        phone: formattedPhone,
        email: customerEmail,
        role: "user",
        isPhoneVerified: true // Pre-verified; ready for OTP login on customer end
      });
      accountCreated = true;
    } else {
      let shouldUpdate = false;
      if (customerName && (!user.name || user.name === "Walk-in Guest" || user.name === "Guest User")) {
        user.name = customerName;
        shouldUpdate = true;
      }
      if (customerEmailRaw && !user.email) {
        user.email = customerEmailRaw;
        shouldUpdate = true;
      }
      if (!user.phone) {
        user.phone = formattedPhone;
        shouldUpdate = true;
      }
      if (!user.isPhoneVerified) {
        user.isPhoneVerified = true;
        shouldUpdate = true;
      }
      if (shouldUpdate) {
        await user.save();
      }
    }

    // Extract booking fields from request body
    const bookingDateRaw = sanitizeString(req.body.bookingDate);
    const bookingType = sanitizeString(req.body.bookingType) === "standard" ? "standard" : "private_event";
    const bookingTime = sanitizeString(req.body.bookingTime);
    const durationHours = Math.max(1, Number(req.body.durationHours || (bookingType === "private_event" ? 4 : 2)));
    const partySize = Math.max(2, Number(req.body.partySize || 2));
    const notes = sanitizeString(req.body.notes);
    const occasion = sanitizeString(req.body.occasion) || (bookingType === "private_event" ? "other" : "quiet");

    if (!bookingDateRaw) {
      res.status(400).json({ success: false, message: "Booking date is required" });
      return;
    }
    if (!bookingTime) {
      res.status(400).json({ success: false, message: "Booking time slot is required" });
      return;
    }

    // 2. Build Date range and fetch existing active bookings
    const { parsedDate, dayStart, dayEnd } = buildDayRange(bookingDateRaw);
    const adjustedStart = new Date(dayStart.getTime() - 6 * 60 * 60 * 1000);

    const occupiedBookings = await Booking.find({
      bookingDate: { $gte: adjustedStart, $lte: dayEnd },
      status: { $in: ["confirmed", "pending"] }
    }).select("tables bookingTime bookingType durationHours");

    let assignedTableIds: any[] = [];
    let complimentaryDrinks = 0;

    if (bookingType === "standard") {
      const bDuration = 120; // 2 hours for standard
      const blockedTableIds = occupiedBookings
        .filter((b) => {
          const dur = b.bookingType === "private_event" ? (b.durationHours || 1) * 60 : 120;
          return isOverlapping(b.bookingTime, dur, bookingTime, bDuration);
        })
        .flatMap((b) => b.tables.map((t) => t.toString()));

      // Check if admin manually selected specific tables
      const requestedTableIds = Array.isArray(req.body.tableIds) && req.body.tableIds.length > 0 ? req.body.tableIds : null;

      if (requestedTableIds) {
        const conflicts = requestedTableIds.filter((tId: string) => blockedTableIds.includes(tId.toString()));
        if (conflicts.length > 0) {
          res.status(400).json({ success: false, message: "One or more of the selected tables are already reserved for this slot" });
          return;
        }
        const tables = await Table.find({ _id: { $in: requestedTableIds } });
        if (tables.length === 0) {
          res.status(400).json({ success: false, message: "Invalid tables selected" });
          return;
        }
        assignedTableIds = tables.map((t) => t._id);
        complimentaryDrinks = tables.length * 2;
      } else {
        // Auto assign tables based on partySize
        const assignment = await assignTables(partySize, bookingDateRaw, blockedTableIds, true);
        if (assignment.error || assignment.tables.length === 0) {
          res.status(400).json({ success: false, message: assignment.error || "No available tables for this time slot" });
          return;
        }
        assignedTableIds = assignment.tables.map((t) => t._id);
        complimentaryDrinks = assignment.complimentaryDrinks;
      }
    } else {
      // Private Event Buyout: assign all tables
      const allTables = await Table.find();
      const eventDurationMins = durationHours * 60;
      const conflicts = occupiedBookings.filter((b) => {
        const dur = b.bookingType === "private_event" ? (b.durationHours || 1) * 60 : 120;
        return isOverlapping(b.bookingTime, dur, bookingTime, eventDurationMins);
      });

      if (conflicts.length > 0 && !req.body.forceOverride) {
        res.status(400).json({
          success: false,
          hasConflict: true,
          conflictCount: conflicts.length,
          message: `Cannot book private buyout: time window conflicts with ${conflicts.length} existing booking(s). You may adjust the time or check 'Override Conflicts'.`
        });
        return;
      }

      assignedTableIds = allTables.map((t) => t._id);
      complimentaryDrinks = allTables.length * 2;
    }

    // 3. Financials & Remaining Balance
    const cakePrice = Number(req.body.cakePrice || 0);
    const defaultTotal = bookingType === "private_event" ? (Number(req.body.totalAmount) || 1500) : (Number(req.body.totalAmount) || 500);
    const totalAmount = Math.max(0, Number(req.body.totalAmount !== undefined ? req.body.totalAmount : defaultTotal));
    const paidAmount = Math.max(0, Number(req.body.paidAmount || 0));
    const remainingAmount = Math.max(0, totalAmount - paidAmount);

    let paymentStatus: "paid" | "deposit_paid" | "pending_payment" = "pending_payment";
    let remainingPaymentStatus: "paid" | "unpaid" = "unpaid";

    if (paidAmount >= totalAmount && totalAmount > 0) {
      paymentStatus = "paid";
      remainingPaymentStatus = "paid";
    } else if (paidAmount > 0) {
      paymentStatus = "deposit_paid";
      remainingPaymentStatus = "unpaid";
    } else {
      paymentStatus = "pending_payment";
      remainingPaymentStatus = "unpaid";
    }

    const paymentMethodRaw = sanitizeString(req.body.paymentMethod).toLowerCase();
    const paymentMethod = ["cash", "card", "zelle", "bank_transfer", "other"].includes(paymentMethodRaw)
      ? (paymentMethodRaw as any)
      : "cash";

    const paymentNotes = sanitizeString(req.body.paymentNotes) || `Admin manual booking (${paymentMethod})`;

    const paymentBreakdown: any[] = [];
    if (paidAmount > 0) {
      paymentBreakdown.push({
        amount: paidAmount,
        paymentMethod,
        paymentType: paidAmount >= totalAmount ? "balance_full" : "deposit",
        status: "verified",
        notes: paymentNotes,
        transactionId: sanitizeString(req.body.transactionId) || "",
        paidAt: new Date()
      });
    }

    // 3b. Calculate payment due date based on admin selection
    const paymentDeadlineSetting = sanitizeString(req.body.paymentDeadline) || "72_hours_before";
    let paymentDueDate: Date | undefined;
    if (remainingAmount > 0) {
      if (paymentDeadlineSetting === "event_time") {
        // Due at event start time on the booking date
        const [startH, startM] = bookingTime.split(":").map(Number);
        paymentDueDate = new Date(parsedDate);
        paymentDueDate.setUTCHours(startH, startM, 0, 0);
      } else {
        // 72 hours before event date
        paymentDueDate = new Date(parsedDate.getTime() - 72 * 60 * 60 * 1000);
      }
    }

    // 4. Create the Booking & Immediately Block Slot & Tables
    const booking = await Booking.create({
      user: user._id,
      tables: assignedTableIds,
      partySize,
      customerName,
      customerEmail,
      customerPhone: formattedPhone,
      notes,
      occasion,
      cakeDetails: sanitizeString(req.body.cakeDetails),
      cakePrice,
      customCakeDetails: req.body.customCakeDetails,
      totalAmount,
      depositAmount: paidAmount,
      remainingAmount,
      paymentStatus,
      remainingPaymentStatus,
      status: "confirmed", // Confirmed by admin immediately blocks the slot in database
      bookingType,
      durationHours,
      needDj: Boolean(req.body.needDj),
      needPhotographer: Boolean(req.body.needPhotographer),
      photographerHours: Number(req.body.photographerHours || 2),
      cateringMenu: sanitizeString(req.body.cateringMenu) || "none",
      complimentaryDrinks,
      bookingDate: parsedDate,
      bookingTime,
      paymentMethod,
      paymentBreakdown,
      isManualBooking: true,
      manualCreatedBy: (req.user as any)?.name || (req.user as any)?.email || "Admin",
      contractedAmount: totalAmount,
      collectedAmount: paidAmount,
      outstandingBalance: remainingAmount,
      paymentDueDate
    });

    // 5. If private event buyout, create SlotLock records for each overlapping slot
    if (bookingType === "private_event") {
      await createSlotLocksForPrivateEvent(booking._id, parsedDate, bookingTime, durationHours);
    }

    // 6. Asynchronous email confirmation if customer provided a real email
    if (customerEmailRaw && customerEmailRaw.includes("@") && !customerEmailRaw.includes("@fishndrop.com")) {
      try {
        if (paymentStatus === "paid" || paymentStatus === "deposit_paid") {
          void sendPaymentEmails(booking);
        }
      } catch (err) {
        console.error("[Manual Booking Email Error]:", err);
      }
    }

    res.status(201).json({
      success: true,
      message: "Manual booking created successfully. Slot has been blocked in the database.",
      booking,
      accountCreated,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role
      },
      financialSummary: {
        totalAmount,
        paidAmount,
        remainingBalance: remainingAmount,
        paymentStatus,
        paymentMethod
      }
    });
  } catch (error: any) {
    console.error("[Create Manual Booking Error]:", error);
    next(new Error(`Failed to create manual booking: ${error.message}`));
  }
};

/**
 * PATCH /api/admin/bookings/:id/mark-paid
 * Admin manually marks a booking as fully paid. Updates payment status,
 * remaining balance, and adds a verified payment breakdown entry.
 */
export const markBookingFullyPaid = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (booking.paymentStatus === "paid" && booking.remainingPaymentStatus === "paid") {
      res.status(400).json({ success: false, message: "Booking is already fully paid" });
      return;
    }

    const remainingToPay = booking.remainingAmount || 0;
    const paymentMethodUsed = sanitizeString(req.body.paymentMethod) || booking.paymentMethod || "cash";
    const adminNotes = sanitizeString(req.body.notes) || "Admin verified as fully paid";

    // Add payment breakdown entry for the remaining amount
    if (remainingToPay > 0) {
      booking.paymentBreakdown = booking.paymentBreakdown || [];
      booking.paymentBreakdown.push({
        amount: remainingToPay,
        paymentMethod: paymentMethodUsed as any,
        paymentType: "balance_full",
        status: "verified",
        transactionId: sanitizeString(req.body.transactionId) || "",
        proofUrl: "",
        iterationIndex: (booking.paymentBreakdown.length || 0) + 1,
        notes: adminNotes,
        paidAt: new Date()
      });
    }

    // Update all payment fields
    booking.paymentStatus = "paid";
    booking.remainingPaymentStatus = "paid";
    booking.remainingAmount = 0;
    booking.collectedAmount = booking.totalAmount;
    booking.outstandingBalance = 0;

    await booking.save();

    res.status(200).json({
      success: true,
      message: "Booking marked as fully paid by admin",
      booking
    });
  } catch (error: any) {
    console.error("[Mark Booking Fully Paid Error]:", error);
    next(new Error("Failed to mark booking as fully paid"));
  }
};

/**
 * GET /api/admin/users
 * Paginated list of all users with booking counts and summary metrics
 */
export const getAllUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search = sanitizeString(req.query.search);
    const role = sanitizeString(req.query.role);
    const verified = sanitizeString(req.query.verified);

    const query: any = {};
    if (role && role !== "all") {
      query.role = role;
    }
    if (verified && verified !== "all") {
      query.isPhoneVerified = verified === "true";
    }
    if (search) {
      const cleanSearch = search.replace(/\D/g, "");
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        ...(cleanSearch ? [{ phone: { $regex: cleanSearch } }] : [])
      ];
    }

    const [users, total, totalUsers, verifiedUsers, adminUsers] = await Promise.all([
      User.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(query),
      User.countDocuments({}),
      User.countDocuments({ isPhoneVerified: true }),
      User.countDocuments({ role: { $in: ["admin", "owner"] } })
    ]);

    // Attach booking stats for the returned users
    const userIds = users.map((u) => u._id);
    const bookingStats = await Booking.aggregate([
      { $match: { user: { $in: userIds } } },
      {
        $group: {
          _id: "$user",
          totalBookings: { $sum: 1 },
          venueBookings: {
            $sum: { $cond: [{ $eq: ["$bookingType", "private_event"] }, 1, 0] }
          },
          lastBookingDate: { $max: "$bookingDate" }
        }
      }
    ]);

    const statsMap = new Map<string, any>();
    bookingStats.forEach((st) => {
      statsMap.set(st._id.toString(), st);
    });

    const enrichedUsers = users.map((u) => {
      const st = statsMap.get(u._id.toString());
      return {
        ...u,
        totalBookings: st?.totalBookings || 0,
        venueBookings: st?.venueBookings || 0,
        lastBookingDate: st?.lastBookingDate || null
      };
    });

    res.status(200).json({
      success: true,
      users: enrichedUsers,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      counts: {
        totalUsers,
        verifiedUsers,
        adminUsers
      }
    });
  } catch (error: any) {
    console.error("[Get All Users Error]:", error);
    next(new Error(`Failed to fetch users: ${error.message}`));
  }
};

/**
 * DELETE /api/admin/users/:id
 * Delete a single user
 */
export const deleteUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const targetId = req.params.id;
    if (req.user?._id?.toString() === targetId) {
      res.status(400).json({ success: false, message: "You cannot delete your own active account" });
      return;
    }

    const user = await User.findById(targetId);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    await User.findByIdAndDelete(targetId);

    res.status(200).json({
      success: true,
      message: `User ${user.name || user.phone} deleted successfully`
    });
  } catch (error: any) {
    console.error("[Delete User Error]:", error);
    next(new Error(`Failed to delete user: ${error.message}`));
  }
};

/**
 * POST /api/admin/users/bulk-delete
 * Delete multiple selected users
 */
export const deleteBulkUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];
    if (userIds.length === 0) {
      res.status(400).json({ success: false, message: "No user IDs provided for deletion" });
      return;
    }

    const currentUserId = req.user?._id?.toString();
    const filteredIds = userIds.filter((id: string) => id !== currentUserId);

    if (filteredIds.length === 0) {
      res.status(400).json({ success: false, message: "Cannot delete your own active account" });
      return;
    }

    const result = await User.deleteMany({ _id: { $in: filteredIds } });

    res.status(200).json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} user(s)`,
      deletedCount: result.deletedCount
    });
  } catch (error: any) {
    console.error("[Bulk Delete Users Error]:", error);
    next(new Error(`Failed to bulk delete users: ${error.message}`));
  }
};

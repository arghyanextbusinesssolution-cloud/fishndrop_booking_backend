import { NextFunction, Request, Response } from "express";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import Table from "../models/Table";
import DailyTableLock from "../models/DailyTableLock";
import { buildDayRange } from "../utils/time.utils";
import { sendPaymentEmails, sendFullPaymentConfirmationViaEmailJS } from "../utils/email.utils";
import { sendGHLBookingEvent } from "../utils/ghl.utils";
import { cleanupExpiredPendingBookings } from "../utils/cleanupExpiredBookings";
import { sendQuoteViaGHL } from "../services/ghlQuote.service";

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

      await sendQuoteViaGHL({
        bookingId: String(booking._id),
        restaurantName,
        dishes: dishesWithQty,
        offerPrice: finalCustomerPrice,
        foodBasePrice: baseFoodPrice,
        tropicaFee: fee,
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
        customerEmail: booking.customerEmail,
        bookingDate: booking.bookingDate ? booking.bookingDate.toISOString().split("T")[0] : "",
        negotiationNotes: negotiationNotes ? sanitizeString(negotiationNotes) : undefined,
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


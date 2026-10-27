import { NextFunction, Request, Response } from "express";
import Booking, { IBooking } from "../models/Booking";

// Helper to determine financial numbers for a booking record
export const calculateBookingFinancials = (b: IBooking) => {
  const contracted = b.contractedAmount || b.totalAmount || 0;
  
  // Calculate collected amount
  let collected = b.collectedAmount || 0;
  if (collected === 0) {
    if (b.paymentStatus === "paid") {
      collected = contracted;
    } else if (b.paymentStatus === "deposit_paid") {
      collected = b.depositAmount || 300;
      if (b.remainingPaymentStatus === "paid") {
        collected += (b.remainingAmount || Math.max(0, contracted - collected));
      }
    }
    // Also include verified payments from paymentBreakdown if present
    if (b.paymentBreakdown && b.paymentBreakdown.length > 0) {
      const breakdownSum = b.paymentBreakdown
        .filter((p) => p.status === "verified")
        .reduce((sum, p) => sum + (p.amount || 0), 0);
      if (breakdownSum > collected) {
        collected = breakdownSum;
      }
    }
    // Food catering payment
    if (b.foodPaymentStatus === "paid" && b.foodBasePrice) {
      // If food was tracked separately from totalAmount
      if (!b.paymentBreakdown || b.paymentBreakdown.every(p => p.paymentType !== "food_catering")) {
        collected += (b.foodBasePrice + (b.foodServiceFee || 0));
      }
    }
  }

  // Refunds
  let refundTotal = b.refundAmount || 0;
  if (b.refunds && b.refunds.length > 0) {
    refundTotal = b.refunds
      .filter(r => r.status === "refunded" || r.status === "partially_refunded")
      .reduce((sum, r) => sum + (r.amount || 0), 0);
  }

  const outstanding = Math.max(0, contracted - collected - refundTotal);

  // Vendor Costs
  let vendorCostsList: Array<{
    _id?: any;
    vendorName: string;
    vendorType: "dj" | "photographer" | "videographer" | "catering" | "other";
    amountOwed: number;
    amountPaid: number;
    paymentStatus: "unpaid" | "partially_paid" | "paid";
    paymentDate?: Date;
    paymentMethod?: string;
    notes?: string;
    markedPaidBy?: string;
  }> = [];

  if (b.vendorCosts && b.vendorCosts.length > 0) {
    vendorCostsList = b.vendorCosts;
  } else {
    // Infer default vendor costs if private event
    if (b.needDj) {
      vendorCostsList.push({
        vendorName: "Tropica Resident DJ",
        vendorType: "dj",
        amountOwed: 200,
        amountPaid: b.paymentStatus === "paid" ? 200 : 0,
        paymentStatus: b.paymentStatus === "paid" ? "paid" : "unpaid",
        notes: "DJ for private event booking"
      });
    }
    if (b.needPhotographer) {
      const cost = (b.photographerHours || 2) * 90;
      vendorCostsList.push({
        vendorName: "Studio Lens Photo/Video",
        vendorType: "photographer",
        amountOwed: cost,
        amountPaid: b.paymentStatus === "paid" ? cost : 0,
        paymentStatus: b.paymentStatus === "paid" ? "paid" : "unpaid",
        notes: `${b.photographerHours || 2}h Photography Coverage`
      });
    }
    const hasPartnerCatering = b.cateringMenu && b.cateringMenu !== "none" && b.cateringMenu !== "no_catering";
    if (hasPartnerCatering && (b.foodBasePrice || b.offerPrice)) {
      const baseFood = b.foodBasePrice || (b.offerPrice ? Math.max(0, b.offerPrice - (b.foodServiceFee || 50)) : 0);
      if (baseFood > 0) {
        const foodCost = Math.round(baseFood * 0.65);
        vendorCostsList.push({
          vendorName: b.cateringMenu || "Catering Partner",
          vendorType: "catering",
          amountOwed: foodCost,
          amountPaid: b.foodPaymentStatus === "paid" ? foodCost : 0,
          paymentStatus: b.foodPaymentStatus === "paid" ? "paid" : "unpaid",
          notes: "Event Catering & Platters"
        });
      }
    }
  }

  const totalVendorOwed = vendorCostsList.reduce((sum, v) => sum + (v.amountOwed || 0), 0);
  const totalVendorPaid = vendorCostsList.reduce((sum, v) => sum + (v.amountPaid || 0), 0);
  const totalVendorPayables = Math.max(0, totalVendorOwed - totalVendorPaid);

  const totalExpenses = b.totalExpenses || totalVendorOwed;
  const netProfit = collected - totalExpenses - refundTotal;
  const profitMargin = contracted > 0 ? Math.round((netProfit / contracted) * 100) : 0;

  // Payment Status Normalized
  let displayPaymentStatus = "Pending Deposit";
  if (b.status === "cancelled") {
    displayPaymentStatus = refundTotal > 0 ? "Cancelled & Refunded" : "Cancelled";
  } else if (refundTotal > 0 && refundTotal >= collected) {
    displayPaymentStatus = "Refunded";
  } else if (refundTotal > 0) {
    displayPaymentStatus = "Partially Refunded";
  } else if (collected >= contracted && contracted > 0) {
    displayPaymentStatus = "Fully Paid";
  } else if (b.paymentStatus === "deposit_paid" && outstanding > 0) {
    displayPaymentStatus = "Balance Due";
  } else if (b.paymentStatus === "deposit_paid") {
    displayPaymentStatus = "Deposit Paid";
  }

  return {
    contracted,
    collected,
    outstanding,
    refundTotal,
    vendorCostsList,
    totalVendorOwed,
    totalVendorPaid,
    totalVendorPayables,
    totalExpenses,
    netProfit,
    profitMargin,
    displayPaymentStatus
  };
};

/**
 * GET /api/admin/financials/stats
 * Summary cards, trend data, and revenue chart grouping
 */
export const getFinancialStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { timeRange = "all", groupBy = "month" } = req.query;

    let dateFilter: any = {};
    const now = new Date();

    if (timeRange === "today") {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      dateFilter = { bookingDate: { $gte: startOfDay } };
    } else if (timeRange === "week") {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - 7);
      dateFilter = { bookingDate: { $gte: startOfWeek } };
    } else if (timeRange === "month") {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = { bookingDate: { $gte: startOfMonth } };
    } else if (timeRange === "year") {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      dateFilter = { bookingDate: { $gte: startOfYear } };
    }

    const bookings = await Booking.find(dateFilter).sort({ bookingDate: 1 });

    let totalContractedRevenue = 0;
    let totalCollected = 0;
    let totalOutstanding = 0;
    let totalUpcomingExpected = 0;
    let totalVendorPayables = 0;
    let totalVendorPaid = 0;
    let totalRefunds = 0;
    let totalNetProfit = 0;

    const chartBuckets: Record<string, { label: string; contracted: number; collected: number; outstanding: number }> = {};

    bookings.forEach((b) => {
      const f = calculateBookingFinancials(b);

      if (b.status === "confirmed") {
        totalContractedRevenue += f.contracted;
        totalCollected += f.collected;
        totalOutstanding += f.outstanding;
        totalVendorPayables += f.totalVendorPayables;
        totalVendorPaid += f.totalVendorPaid;
        totalRefunds += f.refundTotal;
        totalNetProfit += f.netProfit;

        // Upcoming expected (events in the future with outstanding balances)
        const eventDate = new Date(b.bookingDate);
        if (eventDate >= now && f.outstanding > 0) {
          totalUpcomingExpected += f.outstanding;
        }

        // Grouping for Revenue Overview Chart
        let bucketKey = "";
        let label = "";
        if (groupBy === "day") {
          bucketKey = eventDate.toISOString().slice(0, 10);
          label = eventDate.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
        } else if (groupBy === "week") {
          const weekNum = Math.ceil(eventDate.getUTCDate() / 7);
          bucketKey = `${eventDate.getUTCFullYear()}-M${eventDate.getUTCMonth() + 1}-W${weekNum}`;
          label = `${eventDate.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" })} W${weekNum}`;
        } else {
          // month
          bucketKey = `${eventDate.getUTCFullYear()}-${String(eventDate.getUTCMonth() + 1).padStart(2, "0")}`;
          label = eventDate.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "2-digit" });
        }

        if (!chartBuckets[bucketKey]) {
          chartBuckets[bucketKey] = { label, contracted: 0, collected: 0, outstanding: 0 };
        }
        chartBuckets[bucketKey].contracted += f.contracted;
        chartBuckets[bucketKey].collected += f.collected;
        chartBuckets[bucketKey].outstanding += f.outstanding;
      } else if (b.status === "cancelled") {
        totalRefunds += f.refundTotal;
      }
    });

    const revenueChart = Object.keys(chartBuckets)
      .sort()
      .map((k) => chartBuckets[k]);

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalContractedRevenue,
          totalCollected,
          outstandingBalance: totalOutstanding,
          upcomingExpected: totalUpcomingExpected,
          vendorPayables: totalVendorPayables,
          vendorPaid: totalVendorPaid,
          totalRefunds,
          netProfit: totalNetProfit,
          confirmedBookingsCount: bookings.filter((b) => b.status === "confirmed").length
        },
        revenueChart
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/financials/upcoming-payments
 * Table of bookings with pending deposits or balance dues
 */
export const getUpcomingPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, eventType } = req.query;
    let query: any = { status: { $ne: "cancelled" } };

    if (eventType && eventType !== "all") {
      query.bookingType = eventType;
    }

    const bookings = await Booking.find(query).sort({ bookingDate: 1 }).limit(100);

    const list = bookings.map((b) => {
      const f = calculateBookingFinancials(b);
      // Payment due date (default: 72 hours before event)
      const eventDate = new Date(b.bookingDate);
      const dueDate = b.paymentDueDate || new Date(eventDate.getTime() - 72 * 60 * 60 * 1000);

      return {
        _id: b._id,
        bookingId: b._id.toString().slice(-6).toUpperCase(),
        customer: {
          name: b.customerName,
          email: b.customerEmail,
          phone: b.customerPhone
        },
        eventType: b.bookingType === "private_event" ? "Private Venue Buyout" : "Standard Table Booking",
        bookingType: b.bookingType,
        eventDate: b.bookingDate,
        bookingTime: b.bookingTime,
        contractedAmount: f.contracted,
        amountPaid: f.collected,
        balanceDue: f.outstanding,
        paymentDueDate: dueDate,
        status: f.displayPaymentStatus,
        rawPaymentStatus: b.paymentStatus
      };
    });

    const filtered = status && status !== "all" ? list.filter((item) => item.status === status) : list;

    res.status(200).json({
      success: true,
      data: filtered
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/financials/profitability
 * Event profitability report with granular breakdown
 */
export const getEventProfitability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookings = await Booking.find({ status: "confirmed" }).sort({ bookingDate: -1 }).limit(100);

    const profitabilityList = bookings.map((b) => {
      const f = calculateBookingFinancials(b);
      
      // Calculate breakdown details
      const durationHours = b.durationHours || 5;
      const extraHours = durationHours > 5 ? (durationHours - 5) * 300 : 0;
      const baseVenue = 1500;
      const cateringCustomerCharge = b.foodBasePrice ? (b.foodBasePrice + (b.foodServiceFee || 0)) : 0;
      const djCustomerCharge = b.needDj ? 300 : 0;
      const photoCustomerCharge = b.needPhotographer ? (b.photographerHours || 2) * 125 : 0;

      const breakdown = {
        revenue: {
          baseVenueAmount: b.bookingType === "private_event" ? baseVenue : (b.totalAmount || 0),
          extraHours,
          cateringCustomerCharge,
          djCharge: djCustomerCharge,
          photographyCharge: photoCustomerCharge,
          otherAddons: 0,
          discounts: b.discountApplied || 0,
          totalContracted: f.contracted,
          totalCollected: f.collected
        },
        expenses: {
          vendorCosts: f.vendorCostsList,
          totalExpenses: f.totalExpenses,
          refunds: f.refundTotal
        },
        netProfit: f.netProfit,
        profitMargin: f.profitMargin
      };

      return {
        _id: b._id,
        bookingId: b._id.toString().slice(-6).toUpperCase(),
        customer: b.customerName,
        customerEmail: b.customerEmail,
        eventDate: b.bookingDate,
        bookingTime: b.bookingTime,
        eventType: b.bookingType === "private_event" ? "Private Venue Buyout" : "Standard Booking",
        totalRevenue: f.contracted,
        totalCollected: f.collected,
        totalCosts: f.totalExpenses,
        netProfit: f.netProfit,
        profitMargin: f.profitMargin,
        breakdown
      };
    });

    res.status(200).json({
      success: true,
      data: profitabilityList
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/financials/vendor-payables
 * List of all vendor payables across events
 */
export const getVendorPayables = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookings = await Booking.find({ status: "confirmed" }).sort({ bookingDate: -1 });

    const payables: Array<{
      bookingId: string;
      bookingMongoId: string;
      eventDate: Date;
      customerName: string;
      vendorIndex: number;
      vendorName: string;
      vendorType: string;
      amountOwed: number;
      amountPaid: number;
      remaining: number;
      paymentStatus: string;
      paymentDate?: Date;
      paymentMethod?: string;
      notes?: string;
      markedPaidBy?: string;
    }> = [];

    bookings.forEach((b) => {
      const f = calculateBookingFinancials(b);
      f.vendorCostsList.forEach((v, index) => {
        const remaining = Math.max(0, (v.amountOwed || 0) - (v.amountPaid || 0));
        payables.push({
          bookingId: b._id.toString().slice(-6).toUpperCase(),
          bookingMongoId: b._id.toString(),
          eventDate: b.bookingDate,
          customerName: b.customerName,
          vendorIndex: index,
          vendorName: v.vendorName,
          vendorType: v.vendorType,
          amountOwed: v.amountOwed,
          amountPaid: v.amountPaid,
          remaining,
          paymentStatus: v.paymentStatus,
          paymentDate: v.paymentDate,
          paymentMethod: v.paymentMethod,
          notes: v.notes,
          markedPaidBy: v.markedPaidBy
        });
      });
    });

    res.status(200).json({
      success: true,
      data: payables
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/financials/vendor-payables/:bookingId/pay
 * Mark a vendor payable as paid
 */
export const markVendorPaymentPaid = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bookingId } = req.params;
    const { vendorIndex, paidAmount, paymentMethod = "Zelle", notes } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const f = calculateBookingFinancials(booking);
    if (!booking.vendorCosts || booking.vendorCosts.length === 0) {
      // Seed with inferred list first
      booking.vendorCosts = f.vendorCostsList as any;
    }

    const idx = typeof vendorIndex === "number" ? vendorIndex : 0;
    if (booking.vendorCosts && booking.vendorCosts[idx]) {
      const v = booking.vendorCosts[idx];
      const amount = paidAmount !== undefined ? Number(paidAmount) : v.amountOwed;
      v.amountPaid = amount;
      v.paymentStatus = amount >= v.amountOwed ? "paid" : "partially_paid";
      v.paymentDate = new Date();
      v.paymentMethod = paymentMethod;
      v.notes = notes || v.notes;
      v.markedPaidBy = req.user?.name || req.user?.email || "Owner/Admin";
    }

    await booking.save();

    res.status(200).json({
      success: true,
      message: "Vendor payment recorded successfully",
      vendorCosts: booking.vendorCosts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/financials/refunds
 * List of cancelled bookings and refund audit history
 */
export const getRefundsAndCancellations = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bookings = await Booking.find({
      $or: [
        { status: "cancelled" },
        { refundAmount: { $gt: 0 } },
        { "refunds.0": { $exists: true } }
      ]
    }).sort({ updatedAt: -1 });

    const refundRecords = bookings.map((b) => {
      const f = calculateBookingFinancials(b);
      const latestRefund = b.refunds && b.refunds.length > 0 ? b.refunds[b.refunds.length - 1] : null;

      return {
        _id: b._id,
        bookingId: b._id.toString().slice(-6).toUpperCase(),
        customer: b.customerName,
        customerEmail: b.customerEmail,
        eventDate: b.bookingDate,
        cancellationDate: b.updatedAt,
        originalContractValue: f.contracted,
        amountPaid: f.collected,
        refundAmount: f.refundTotal,
        refundStatus: latestRefund?.status || (f.refundTotal >= f.collected ? "refunded" : f.refundTotal > 0 ? "partially_refunded" : "no_refund"),
        cancellationReason: latestRefund?.reason || b.notes || "Customer cancellation",
        processedBy: latestRefund?.processedBy || "Owner/Admin",
        processedAt: latestRefund?.processedAt || b.updatedAt
      };
    });

    res.status(200).json({
      success: true,
      data: refundRecords
    });
  } catch (error) {
    next(error);
  }
};

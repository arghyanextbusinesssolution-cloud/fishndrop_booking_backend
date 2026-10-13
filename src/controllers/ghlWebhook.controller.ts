import { Request, Response, NextFunction } from "express";
import Booking from "../models/Booking";

/**
 * POST /api/webhooks/ghl/quote-update
 *
 * Inbound endpoint for GoHighLevel (GHL) to push quote acceptance or rejection
 * back to the Tropica booking system.
 *
 * Expected JSON body:
 *   {
 *     "bookingId": "<MongoDB _id>",
 *     "action": "accept" | "reject",
 *     "notes": "Optional admin notes from GHL"
 *   }
 *
 * On success updates booking.offerStatus and appends to quoteHistory.
 * Returns the updated booking as JSON.
 */
export const ghlQuoteUpdateWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { bookingId, action, notes } = req.body;

    if (!bookingId) {
      res.status(400).json({ success: false, message: "bookingId is required" });
      return;
    }

    if (!["accept", "reject"].includes(action)) {
      res.status(400).json({ success: false, message: "action must be 'accept' or 'reject'" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    booking.quoteHistory = booking.quoteHistory || [];

    if (action === "accept") {
      booking.offerStatus = "accepted";
      booking.quoteHistory.push({
        action: "quote_accepted",
        actor: "admin",
        actorName: "GHL / Tropica Admin",
        price: booking.offerPrice,
        notes: notes || `Customer accepted catering quote of $${booking.offerPrice?.toFixed(2) || "0.00"} — confirmed via GHL`,
        createdAt: new Date()
      });

      console.log(`? [GHL WEBHOOK] Quote ACCEPTED for booking ${bookingId} ($${booking.offerPrice})`);
    } else {
      booking.offerStatus = "declined";
      booking.quoteHistory.push({
        action: "quote_rejected",
        actor: "admin",
        actorName: "GHL / Tropica Admin",
        price: booking.offerPrice,
        notes: notes || "Customer declined the catering quote — updated via GHL",
        createdAt: new Date()
      });

      console.log(`? [GHL WEBHOOK] Quote REJECTED for booking ${bookingId}`);
    }

    await booking.save();

    res.status(200).json({
      success: true,
      message: action === "accept" ? "Quote marked as accepted." : "Quote marked as rejected.",
      bookingId: String(booking._id),
      offerStatus: booking.offerStatus
    });
  } catch (error: any) {
    console.error("[GHL QUOTE UPDATE WEBHOOK ERROR]:", error?.message);
    next(new Error("Failed to process GHL quote update webhook"));
  }
};

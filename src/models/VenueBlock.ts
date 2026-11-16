import { Document, Schema, Types, model } from "mongoose";

/**
 * A blocked time range on a partner venue. "booking" blocks are created when a marketplace
 * booking is paid; "manual" blocks are added by Sarah (owner told us the venue is unavailable).
 *
 * Times follow the venueAvailability.service convention: `date` is the New York session date
 * (YYYY-MM-DD) and start/end are minutes from 00:00 that day (end may exceed 1440 for late nights).
 */
export interface IVenueBlock extends Document {
  venue: Types.ObjectId;
  date: string;
  startMin: number;
  endMin: number;
  reason: "manual" | "booking";
  booking?: Types.ObjectId;
  note?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
}

const venueBlockSchema = new Schema<IVenueBlock>(
  {
    venue: { type: Schema.Types.ObjectId, ref: "PartnerVenue", required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startMin: { type: Number, required: true, min: 0, max: 48 * 60 },
    endMin: { type: Number, required: true, min: 1, max: 48 * 60 },
    reason: { type: String, enum: ["manual", "booking"], required: true },
    booking: { type: Schema.Types.ObjectId, ref: "MarketplaceBooking" },
    note: { type: String, maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

venueBlockSchema.index({ venue: 1, date: 1 });
// One block per booking — makes the "confirm on payment" path idempotent.
venueBlockSchema.index({ booking: 1 }, { unique: true, partialFilterExpression: { booking: { $exists: true } } });

const VenueBlock = model<IVenueBlock>("VenueBlock", venueBlockSchema);
export default VenueBlock;

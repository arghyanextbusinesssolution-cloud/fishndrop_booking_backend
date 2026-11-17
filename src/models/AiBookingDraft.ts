import { Document, Schema, Types, model } from "mongoose";

/**
 * A venue booking the AI assistant prepared in a DM after the customer said "yes".
 *
 * - `code` is the booking ID the customer gets (e.g. "TRP-7K2M9Q") and is part of their checkout link.
 * - The venue window is HELD for 30 minutes (`holdExpiresAt`) — no one else can book it meanwhile.
 * - The draft itself is kept for 1 hour (`expiresAt`, Mongo TTL) and then deleted automatically.
 * - On the website the customer verifies their phone and pays; that turns it into a real Booking.
 */

export type AiDraftStatus = "held" | "completed" | "cancelled";

export interface IAiBookingDraft extends Document {
  code: string;
  contactId?: string;
  channel?: string;
  status: AiDraftStatus;
  date: string; // YYYY-MM-DD (New York)
  startTime: string; // HH:MM 24h
  durationHours: number;
  guests: number;
  seating?: "seated" | "standing";
  occasion?: string;
  needDj: boolean;
  needPhotographer: boolean;
  photographerHours: number;
  fullName?: string;
  phone?: string;
  email?: string;
  notes?: string;
  quote: {
    billableGuests: number;
    base: number;
    extraHours: number;
    extraHoursCost: number;
    dj: number;
    photographer: number;
    total: number;
    deposit: number;
    balance: number;
  };
  holdExpiresAt: Date;
  expiresAt: Date;
  bookingId?: Types.ObjectId;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const draftSchema = new Schema<IAiBookingDraft>(
  {
    code: { type: String, required: true, unique: true, index: true },
    contactId: { type: String, index: true },
    channel: String,
    status: { type: String, enum: ["held", "completed", "cancelled"], default: "held", index: true },
    date: { type: String, required: true, index: true },
    startTime: { type: String, required: true },
    durationHours: { type: Number, required: true },
    guests: { type: Number, required: true },
    seating: { type: String, enum: ["seated", "standing"] },
    occasion: String,
    needDj: { type: Boolean, default: false },
    needPhotographer: { type: Boolean, default: false },
    photographerHours: { type: Number, default: 0 },
    fullName: String,
    phone: String,
    email: String,
    notes: { type: String, maxlength: 1000 },
    quote: {
      billableGuests: Number,
      base: Number,
      extraHours: Number,
      extraHoursCost: Number,
      dj: Number,
      photographer: Number,
      total: Number,
      deposit: Number,
      balance: Number
    },
    holdExpiresAt: { type: Date, required: true },
    // Mongo deletes the document at this time (1 hour after creation)
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    completedAt: Date
  },
  { timestamps: true }
);

export default model<IAiBookingDraft>("AiBookingDraft", draftSchema);

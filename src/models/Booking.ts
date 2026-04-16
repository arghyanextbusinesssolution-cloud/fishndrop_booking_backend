import { Document, Schema, Types, model } from "mongoose";

export interface IBooking extends Document {
  user: Types.ObjectId;
  tables: Types.ObjectId[];
  partySize: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  notes?: string;
  occasion: "birthday" | "anniversary" | "graduation" | "business" | "quiet" | "other";
  cakeDetails?: string; // Legacy
  cakePrice?: number; // Legacy
  customCakeDetails?: {
    size: string;
    flavor: string;
    type: string;
    designStyle: string[];
    message: string;
    specialInstructions: string;
    referencePhotoUrl: string;
    retailPrice: number;
  };
  totalAmount: number;
  complimentaryDrinks: number;
  bookingDate: Date;
  bookingTime: string;
  status: "confirmed" | "cancelled";
  /** Set when table is held; cleared to paid after Stripe Checkout succeeds. */
  paymentStatus: "pending_payment" | "paid";
}

const bookingSchema = new Schema<IBooking>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tables: [{ type: Schema.Types.ObjectId, ref: "Table" }],
    partySize: { type: Number, required: true, min: 2 },
    customerName: { type: String, required: true, trim: true, maxlength: 100 },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, required: true, trim: true, maxlength: 20 },
    notes: { type: String, trim: true, maxlength: 500 },
    occasion: { type: String, enum: ["birthday", "anniversary", "graduation", "business", "quiet", "other"], required: true },
    cakeDetails: { type: String, trim: true, maxlength: 500 }, // Legacy
    cakePrice: { type: Number, min: 0, default: 0 }, // Legacy
    customCakeDetails: {
      size: String,
      flavor: String,
      type: { type: String },
      designStyle: [{ type: String }],
      message: String,
      specialInstructions: String,
      referencePhotoUrl: String,
      retailPrice: Number
    },
    totalAmount: { type: Number, required: true },
    complimentaryDrinks: { type: Number, default: 0 },
    bookingDate: { type: Date, required: true },
    bookingTime: { type: String, required: true },
    status: { type: String, enum: ["confirmed", "cancelled"], default: "confirmed" },
    paymentStatus: {
      type: String,
      enum: ["pending_payment", "paid"],
      default: "pending_payment"
    }
  },
  { timestamps: true }
);

bookingSchema.index({ user: 1 });
bookingSchema.index({ bookingDate: 1 });

const Booking = model<IBooking>("Booking", bookingSchema);
export default Booking;

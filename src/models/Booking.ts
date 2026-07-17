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
  status: "pending" | "confirmed" | "cancelled";
  /** For Private events: starts at pending_payment, moves to deposit_paid on $200 checkout, then paid when balance is settled. For standard: pending_payment -> paid */
  paymentStatus: "pending_payment" | "deposit_paid" | "paid";
  bookingType: "standard" | "private_event";
  durationHours?: number;

  // Referral Coupon Fields
  couponUsed?: Types.ObjectId;
  couponCode?: string;
  promoterName?: string;
  discountApplied?: number;
  originalAmount?: number;
  finalAmount?: number;

  // Partial payment fields (private_event only)
  depositAmount: number;
  remainingAmount: number;
  remainingPaymentStatus: "unpaid" | "paid";
  remainingPaymentReminderSent: boolean;
  remainingPaymentSessionId?: string;
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
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },
    paymentStatus: {
      type: String,
      enum: ["pending_payment", "deposit_paid", "paid"],
      default: "pending_payment"
    },
    bookingType: {
      type: String,
      enum: ["standard", "private_event"],
      default: "standard"
    },
    durationHours: {
      type: Number
    },
    couponUsed: {
      type: Schema.Types.ObjectId,
      ref: "Coupon"
    },
    couponCode: { type: String },
    promoterName: { type: String },
    discountApplied: { type: Number, default: 0 },
    originalAmount: { type: Number },
    finalAmount: { type: Number },
    depositAmount: {
      type: Number,
      default: 0
    },
    remainingAmount: {
      type: Number,
      default: 0
    },
    remainingPaymentStatus: {
      type: String,
      enum: ["unpaid", "paid"],
      default: "unpaid"
    },
    remainingPaymentReminderSent: {
      type: Boolean,
      default: false
    },
    remainingPaymentSessionId: {
      type: String
    }
  },
  { timestamps: true }
);

bookingSchema.index({ user: 1 });
bookingSchema.index({ bookingDate: 1 });

const Booking = model<IBooking>("Booking", bookingSchema);
export default Booking;

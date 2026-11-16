import { Document, Schema, Types, model } from "mongoose";

export type MarketplaceBookingStatus =
  | "requested"
  | "availability_confirmed"
  | "deposit_paid"
  | "paid"
  | "completed"
  | "declined"
  | "expired"
  | "cancelled";

/** Statuses in which the booking holds (or will hold) the venue slot. */
export const ACTIVE_MARKETPLACE_STATUSES: MarketplaceBookingStatus[] = ["deposit_paid", "paid"];

export interface IMarketplacePayment {
  amount: number;
  applicationFee: number;
  paymentType: "deposit" | "full" | "balance";
  status: "succeeded" | "refunded" | "partially_refunded";
  transactionId: string;
  connectAccountId?: string;
  paidAt: Date;
  /** Payments Tropica collected itself: the Stripe transfer that later sent the venue its share. */
  transferId?: string;
  transferredAmount?: number;
}

export interface IMarketplaceRefund {
  amount: number;
  stripeRefundId?: string;
  reason?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
}

export interface IMarketplaceBooking extends Document {
  bookingNumber: string;
  user: Types.ObjectId;
  venue: Types.ObjectId;
  venueName: string;

  date: string;
  startTime: string;
  endTime: string;
  startMin: number;
  endMin: number;
  durationHours: number;
  guests: number;
  packageId?: Types.ObjectId;
  packageName?: string;

  customerName: string;
  customerEmail: string;
  customerPhone: string;
  occasion?: string;
  birthday?: string;
  notes?: string;
  addons?: Record<string, unknown>;

  // Celebration (guest list) — opens once the booking is paid
  invitationToken?: string;
  requireHostApproval?: boolean;
  eventTitle?: string;
  flyerUrl?: string;

  status: MarketplaceBookingStatus;

  regularPrice: number;
  customerPrice: number;
  venuePayout: number;
  commission: number;
  depositPct: number;
  depositAmount: number;
  amountPaid: number;
  remainingAmount: number;
  priceOverridden: boolean;
  quoteNote?: string;

  payments: IMarketplacePayment[];
  refunds: IMarketplaceRefund[];
  stripePaymentIntentId?: string;
  paymentLinkSentAt?: Date;
  paymentLinkExpiresAt?: Date;
  confirmedAt?: Date;
  confirmationClaimed: boolean;

  settlement: {
    mode: "connect" | "manual";
    status: "pending" | "transferred" | "paid_manually";
    paidAt?: Date;
    reference?: string;
    transferredAmount?: number;
    settledBy?: Types.ObjectId;
  };

  declineReason?: string;
  cancelReason?: string;
  cancelledAt?: Date;
  /** Who confirmed/declined the request — normally the venue owner; staff only as backup. */
  respondedBy?: Types.ObjectId;
  respondedByRole?: "venue_owner" | "staff" | "admin" | "owner";
  respondedAt?: Date;
  ownerReminderSentAt?: Date;
  staffEscalatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IMarketplacePayment>(
  {
    amount: { type: Number, required: true },
    applicationFee: { type: Number, default: 0 },
    paymentType: { type: String, enum: ["deposit", "full", "balance"], required: true },
    status: { type: String, enum: ["succeeded", "refunded", "partially_refunded"], default: "succeeded" },
    transactionId: { type: String, required: true },
    connectAccountId: { type: String },
    paidAt: { type: Date, default: Date.now },
    transferId: { type: String },
    transferredAmount: { type: Number }
  },
  { _id: false }
);

const refundSchema = new Schema<IMarketplaceRefund>(
  {
    amount: { type: Number, required: true },
    stripeRefundId: { type: String },
    reason: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const marketplaceBookingSchema = new Schema<IMarketplaceBooking>(
  {
    bookingNumber: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    venue: { type: Schema.Types.ObjectId, ref: "PartnerVenue", required: true, index: true },
    venueName: { type: String, required: true },

    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    startMin: { type: Number, required: true },
    endMin: { type: Number, required: true },
    durationHours: { type: Number, required: true, min: 1 },
    guests: { type: Number, required: true, min: 1 },
    packageId: { type: Schema.Types.ObjectId },
    packageName: { type: String },

    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, required: true, trim: true },
    occasion: { type: String, trim: true },
    birthday: { type: String },
    notes: { type: String, maxlength: 2000 },
    addons: { type: Schema.Types.Mixed },

    invitationToken: { type: String, unique: true, sparse: true },
    requireHostApproval: { type: Boolean, default: false },
    eventTitle: { type: String, trim: true, maxlength: 80 },
    flyerUrl: { type: String },

    status: {
      type: String,
      enum: ["requested", "availability_confirmed", "deposit_paid", "paid", "completed", "declined", "expired", "cancelled"],
      default: "requested",
      index: true
    },

    regularPrice: { type: Number, required: true, min: 0 },
    customerPrice: { type: Number, required: true, min: 0 },
    venuePayout: { type: Number, required: true, min: 0 },
    commission: { type: Number, required: true },
    depositPct: { type: Number, required: true, min: 1, max: 100 },
    depositAmount: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0 },
    remainingAmount: { type: Number, required: true, min: 0 },
    priceOverridden: { type: Boolean, default: false },
    quoteNote: { type: String, maxlength: 1000 },

    payments: { type: [paymentSchema], default: [] },
    refunds: { type: [refundSchema], default: [] },
    stripePaymentIntentId: { type: String },
    paymentLinkSentAt: { type: Date },
    paymentLinkExpiresAt: { type: Date },
    confirmedAt: { type: Date },
    confirmationClaimed: { type: Boolean, default: false },

    settlement: {
      mode: { type: String, enum: ["connect", "manual"], default: "manual" },
      status: { type: String, enum: ["pending", "transferred", "paid_manually"], default: "pending" },
      paidAt: { type: Date },
      reference: { type: String },
      transferredAmount: { type: Number, default: 0 },
      settledBy: { type: Schema.Types.ObjectId, ref: "User" }
    },

    declineReason: { type: String },
    cancelReason: { type: String },
    cancelledAt: { type: Date },
    respondedBy: { type: Schema.Types.ObjectId, ref: "User" },
    respondedByRole: { type: String, enum: ["venue_owner", "staff", "admin", "owner"] },
    respondedAt: { type: Date },
    ownerReminderSentAt: { type: Date },
    staffEscalatedAt: { type: Date }
  },
  { timestamps: true }
);

marketplaceBookingSchema.index({ venue: 1, date: 1, status: 1 });
marketplaceBookingSchema.index({ "payments.transactionId": 1 });

const MarketplaceBooking = model<IMarketplaceBooking>("MarketplaceBooking", marketplaceBookingSchema);
export default MarketplaceBooking;

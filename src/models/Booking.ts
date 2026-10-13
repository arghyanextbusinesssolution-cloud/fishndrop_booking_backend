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
  needDj?: boolean;
  needPhotographer?: boolean;
  photographerHours?: number;
  cateringMenu?: string;

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

  // Payment Breakdown / Installments Tracking
  paymentBreakdown?: Array<{
    amount: number;
    paymentMethod: "card" | "zelle";
    paymentType: "deposit" | "balance_partial" | "balance_full" | "food_catering";
    status: "verified" | "pending";
    transactionId?: string;
    proofUrl?: string;
    iterationIndex?: number;
    notes?: string;
    paidAt: Date;
  }>;

  // Zelle Payment & GHL Verification Fields
  paymentMethod?: "card" | "zelle";
  zelleProofUrl?: string;
  remainingZelleProofUrl?: string;
  zelleVerificationStatus?: "none" | "pending_ghl_verification" | "verified" | "mismatched" | "manual_review";
  remainingZelleVerificationStatus?: "none" | "pending_ghl_verification" | "verified" | "mismatched" | "manual_review";
  // Negotiation / Offer Price fields
  offerPrice?: number;
  negotiationNotes?: string;
  offerStatus?: "pending" | "offered" | "accepted" | "declined";
  foodBasePrice?: number;
  foodServiceFee?: number;
  foodPaymentStatus?: "unpaid" | "paid" | "pending_verification";
  foodPaymentMethod?: "card" | "zelle";
  foodZelleProofUrl?: string;
  foodPaidAt?: Date;
  dishQuantities?: Record<string, number>; // { "Dish Name": plattersCount }
  quoteHistory?: Array<{
    action: "inquiry_created" | "quote_sent" | "quote_accepted" | "quote_rejected" | "menu_updated";
    actor: "admin" | "user";
    actorName?: string;
    price?: number;
    notes?: string;
    cateringMenu?: string;
    dishes?: string[];
    dishQuantities?: Record<string, number>;
    createdAt: Date;
  }>;

  zelleTransactionId?: string;
  zelleNotes?: string;
  zelleUploadedAt?: Date;

  // Owner Financial Tracking & Profitability
  contractedAmount?: number;
  collectedAmount?: number;
  outstandingBalance?: number;
  paymentDueDate?: Date;
  refundAmount?: number;
  totalExpenses?: number;
  netProfit?: number;
  vendorCosts?: Array<{
    vendorId?: string;
    vendorName: string;
    vendorType: "dj" | "photographer" | "videographer" | "catering" | "other";
    amountOwed: number;
    amountPaid: number;
    paymentStatus: "unpaid" | "partially_paid" | "paid";
    paymentDate?: Date;
    paymentMethod?: string;
    notes?: string;
    markedPaidBy?: string;
  }>;
  refunds?: Array<{
    amount: number;
    reason: string;
    status: "no_refund" | "refund_pending" | "partially_refunded" | "refunded";
    processedBy?: string;
    processedAt?: Date;
    notes?: string;
  }>;

  createdAt?: Date;
  updatedAt?: Date;
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
    occasion: { type: String, required: true, trim: true },
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
    needDj: {
      type: Boolean,
      default: false
    },
    needPhotographer: {
      type: Boolean,
      default: false
    },
    photographerHours: {
      type: Number,
      default: 2
    },
    cateringMenu: {
      type: String,
      trim: true
    },
    dishQuantities: {
      type: Map,
      of: Number,
      default: {}
    },
    offerPrice: { type: Number },
    negotiationNotes: { type: String, trim: true, maxlength: 500 },
    offerStatus: { type: String, enum: ["pending", "offered", "accepted", "declined"], default: "pending" },
    foodBasePrice: { type: Number },
    foodServiceFee: { type: Number, default: 50 },
    foodPaymentStatus: { type: String, enum: ["unpaid", "paid", "pending_verification"], default: "unpaid" },
    foodPaymentMethod: { type: String, enum: ["card", "zelle"] },
    foodZelleProofUrl: { type: String },
    foodPaidAt: { type: Date },
    quoteHistory: [
      {
        action: { type: String, required: true },
        actor: { type: String, required: true },
        actorName: { type: String },
        price: { type: Number },
        notes: { type: String },
        cateringMenu: { type: String },
        dishes: [{ type: String }],
        dishQuantities: { type: Map, of: Number },
        createdAt: { type: Date, default: Date.now }
      }
    ],
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
    },
    paymentBreakdown: [
      {
        amount: { type: Number, required: true },
        paymentMethod: { type: String, enum: ["card", "zelle"], default: "card" },
        paymentType: { type: String, enum: ["deposit", "balance_partial", "balance_full"], default: "balance_full" },
        status: { type: String, enum: ["verified", "pending"], default: "verified" },
        transactionId: { type: String, default: "" },
        proofUrl: { type: String, default: "" },
        iterationIndex: { type: Number, default: 1 },
        notes: { type: String, default: "" },
        paidAt: { type: Date, default: Date.now }
      }
    ],
    paymentMethod: {
      type: String,
      enum: ["card", "zelle"],
      default: "card"
    },
    zelleProofUrl: {
      type: String,
      default: ""
    },
    remainingZelleProofUrl: {
      type: String,
      default: ""
    },
    zelleVerificationStatus: {
      type: String,
      enum: ["none", "pending_ghl_verification", "verified", "mismatched", "manual_review"],
      default: "none"
    },
    remainingZelleVerificationStatus: {
      type: String,
      enum: ["none", "pending_ghl_verification", "verified", "mismatched", "manual_review"],
      default: "none"
    },
    zelleTransactionId: {
      type: String,
      default: ""
    },
    zelleNotes: {
      type: String,
      default: ""
    },
    zelleUploadedAt: {
      type: Date
    },
    // Owner Financial Tracking & Profitability
    contractedAmount: { type: Number },
    collectedAmount: { type: Number, default: 0 },
    outstandingBalance: { type: Number },
    paymentDueDate: { type: Date },
    refundAmount: { type: Number, default: 0 },
    totalExpenses: { type: Number, default: 0 },
    netProfit: { type: Number, default: 0 },
    vendorCosts: [
      {
        vendorId: { type: String },
        vendorName: { type: String, required: true },
        vendorType: {
          type: String,
          enum: ["dj", "photographer", "videographer", "catering", "other"],
          required: true
        },
        amountOwed: { type: Number, required: true, default: 0 },
        amountPaid: { type: Number, default: 0 },
        paymentStatus: {
          type: String,
          enum: ["unpaid", "partially_paid", "paid"],
          default: "unpaid"
        },
        paymentDate: { type: Date },
        paymentMethod: { type: String },
        notes: { type: String },
        markedPaidBy: { type: String }
      }
    ],
    refunds: [
      {
        amount: { type: Number, required: true },
        reason: { type: String, required: true },
        status: {
          type: String,
          enum: ["no_refund", "refund_pending", "partially_refunded", "refunded"],
          default: "refunded"
        },
        processedBy: { type: String },
        processedAt: { type: Date, default: Date.now },
        notes: { type: String }
      }
    ]
  },
  { timestamps: true }
);

bookingSchema.index({ user: 1 });
bookingSchema.index({ bookingDate: 1 });

const Booking = model<IBooking>("Booking", bookingSchema);
export default Booking;

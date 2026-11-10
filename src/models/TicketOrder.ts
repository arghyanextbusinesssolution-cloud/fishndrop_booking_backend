import { Document, Schema, Types, model } from "mongoose";

export interface IOrderItem {
  tierId: Types.ObjectId;
  tierName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface ITicketOrder extends Document {
  orderNumber: string; // e.g. TRP-ORD-12345
  event: Types.ObjectId;
  promoter: Types.ObjectId;
  user?: Types.ObjectId; // verified buyer account (phone OTP)
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerDob?: string; // "YYYY-MM-DD" snapshot at purchase (birthday bonus)
  items: IOrderItem[];
  subtotal: number;
  platformFee: number;
  processingFee?: number;
  totalAmount: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "cancelled" | "refunded";
  qrMode?: "individual" | "group"; // buyer's choice after payment
  groupQrToken?: string; // legacy: one QR that admitted every ticket in the order
  shareToken?: string; // one link the buyer shares so guests can claim the extra seats
  guestCancelDeadline?: Date; // accepted guests may cancel until paidAt + 48h
  rejectedPhones?: string[]; // guests the buyer declined; they can't re-request
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  stripeConnectAccountId?: string;
  stripeTransferId?: string;
  paidAt?: Date;
  expiresAt: Date; // 15-minute reservation TTL
  refundAmount?: number;
  refundReason?: string;
  refundedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    tierId: { type: Schema.Types.ObjectId, required: true },
    tierName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const ticketOrderSchema = new Schema<ITicketOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    promoter: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    customerName: { type: String, required: true, trim: true, maxlength: 100 },
    customerEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    customerPhone: { type: String, required: true, trim: true },
    customerDob: { type: String, trim: true },
    items: [orderItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, required: true, min: 0, default: 0 },
    processingFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd" },
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "cancelled", "refunded"],
      default: "pending",
      index: true
    },
    qrMode: { type: String, enum: ["individual", "group"] },
    groupQrToken: { type: String, unique: true, sparse: true },
    shareToken: { type: String, unique: true, sparse: true },
    guestCancelDeadline: { type: Date },
    rejectedPhones: { type: [String], default: [] },
    stripeCheckoutSessionId: { type: String, index: true },
    stripePaymentIntentId: { type: String },
    stripeConnectAccountId: { type: String },
    stripeTransferId: { type: String },
    paidAt: { type: Date },
    expiresAt: { type: Date, required: true, index: true },
    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String },
    refundedAt: { type: Date }
  },
  { timestamps: true }
);

export const generateOrderNumber = (): string => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(1000 + Math.random() * 9000);
  return `TRP-ORD-${timestamp}-${random}`;
};

const TicketOrder = model<ITicketOrder>("TicketOrder", ticketOrderSchema);
export default TicketOrder;


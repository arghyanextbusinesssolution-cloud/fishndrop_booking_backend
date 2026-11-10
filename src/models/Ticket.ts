import crypto from "crypto";
import { Document, Schema, Types, model } from "mongoose";

export interface ITicket extends Document {
  ticketCode: string; // e.g. TRP-TK-8F4A2B
  order: Types.ObjectId;
  event: Types.ObjectId;
  promoter: Types.ObjectId;
  user?: Types.ObjectId;
  tierId: Types.ObjectId;
  tierName: string;
  price: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  qrCodeToken: string; // Unique cryptographic token verified by QR scanner
  status: "valid" | "used" | "refunded" | "cancelled";
  checkedIn: boolean;
  checkedInAt?: Date;
  checkedInBy?: Types.ObjectId;
  checkedInByName?: string;
  notes?: string;
  // Guest sharing: who actually holds (and enters with) this seat.
  // Legacy tickets have no holderStatus and behave as held by the buyer.
  isBuyerSeat?: boolean;
  holderStatus?: "unassigned" | "pending" | "accepted";
  holderUser?: Types.ObjectId;
  holderName?: string;
  holderPhone?: string;
  holderEmail?: string;
  requestedAt?: Date;
  acceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ticketSchema = new Schema<ITicket>(
  {
    ticketCode: { type: String, required: true, unique: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: "TicketOrder", required: true, index: true },
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    promoter: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    tierId: { type: Schema.Types.ObjectId, required: true },
    tierName: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    customerPhone: { type: String, required: true, trim: true },
    qrCodeToken: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["valid", "used", "refunded", "cancelled"],
      default: "valid",
      index: true
    },
    checkedIn: { type: Boolean, default: false, index: true },
    checkedInAt: { type: Date },
    checkedInBy: { type: Schema.Types.ObjectId, ref: "User" },
    checkedInByName: { type: String, trim: true },
    notes: { type: String, trim: true },
    isBuyerSeat: { type: Boolean, default: false },
    holderStatus: { type: String, enum: ["unassigned", "pending", "accepted"], index: true },
    holderUser: { type: Schema.Types.ObjectId, ref: "User", index: true },
    holderName: { type: String, trim: true, maxlength: 100 },
    holderPhone: { type: String, trim: true, index: true },
    holderEmail: { type: String, trim: true, lowercase: true },
    requestedAt: { type: Date },
    acceptedAt: { type: Date }
  },
  { timestamps: true }
);

export const generateTicketCode = (): string => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TRP-TK-${code}`;
};

export const generateQrCodeToken = (): string => {
  return crypto.randomBytes(32).toString("hex");
};

const Ticket = model<ITicket>("Ticket", ticketSchema);
export default Ticket;


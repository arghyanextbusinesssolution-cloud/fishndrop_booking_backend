import crypto from "crypto";
import { Document, Schema, Types, model } from "mongoose";

export interface IGuestPass extends Document {
  booking: Types.ObjectId;
  user?: Types.ObjectId; // guest's phone-verified Tropica account
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  qrCodeToken: string;
  passCode: string; // e.g. TRP-GP-9A8B7C
  status: "pending_approval" | "approved" | "rejected";
  checkedIn: boolean;
  checkedInAt?: Date;
  checkedInBy?: Types.ObjectId;
  checkedInByName?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const guestPassSchema = new Schema<IGuestPass>(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    guestName: { type: String, required: true, trim: true, maxlength: 100 },
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    guestEmail: { type: String, default: "", trim: true, lowercase: true },
    guestPhone: { type: String, required: true, trim: true },
    qrCodeToken: { type: String, required: true, unique: true, index: true },
    passCode: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["pending_approval", "approved", "rejected"],
      default: "approved",
      index: true
    },
    checkedIn: { type: Boolean, default: false, index: true },
    checkedInAt: { type: Date },
    checkedInBy: { type: Schema.Types.ObjectId, ref: "User" },
    checkedInByName: { type: String, trim: true },
    notes: { type: String, trim: true }
  },
  { timestamps: true }
);

export const generateGuestPassCode = (): string => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TRP-GP-${code}`;
};

export const generateGuestQrToken = (): string => {
  return crypto.randomBytes(32).toString("hex");
};

const GuestPass = model<IGuestPass>("GuestPass", guestPassSchema);
export default GuestPass;


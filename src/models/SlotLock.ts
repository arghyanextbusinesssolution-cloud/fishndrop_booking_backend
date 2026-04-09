import { Document, Schema, model } from "mongoose";

export interface ISlotLock extends Document {
  bookingDate: Date;
  bookingTime: string;
  isLocked: boolean;
  reason?: string;
}

const slotLockSchema = new Schema<ISlotLock>(
  {
    bookingDate: { type: Date, required: true },
    bookingTime: { type: String, required: true, trim: true },
    isLocked: { type: Boolean, default: true },
    reason: { type: String, trim: true, maxlength: 250 }
  },
  { timestamps: true }
);

slotLockSchema.index({ bookingDate: 1, bookingTime: 1 }, { unique: true });

const SlotLock = model<ISlotLock>("SlotLock", slotLockSchema);
export default SlotLock;


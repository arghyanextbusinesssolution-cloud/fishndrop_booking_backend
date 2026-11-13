import { Document, Schema, model, Types } from "mongoose";

export interface ISlotLock extends Document {
  bookingDate: Date;
  bookingTime: string;
  isLocked: boolean;
  reason?: string;
  eventId?: Types.ObjectId;
}

const slotLockSchema = new Schema<ISlotLock>(
  {
    bookingDate: { type: Date, required: true },
    bookingTime: { type: String, required: true, trim: true },
    isLocked: { type: Boolean, default: true },
    reason: { type: String, trim: true, maxlength: 250 },
    eventId: { type: Schema.Types.ObjectId, ref: "Booking" }
  },
  { timestamps: true }
);

slotLockSchema.index({ bookingDate: 1, bookingTime: 1 }, { unique: true });

// ── GHL: any block / unblock (admin, private party, cancel, reschedule, cleanup) pushes the
// venue's blocked-slot list to GHL so its AI never offers a taken time. Debounced (~5 s).
const pushAvailability = () => {
  // Lazy require: the trigger loads this model
  const { scheduleAvailabilitySync } = require("../integrations/ghl/triggers/availability/availabilityUpdated.trigger");
  scheduleAvailabilitySync("slot_lock_changed");
};
slotLockSchema.post("save", pushAvailability);
slotLockSchema.post("insertMany", pushAvailability);
slotLockSchema.post(["deleteOne", "deleteMany", "findOneAndDelete", "findOneAndUpdate", "updateOne", "updateMany"], { document: false, query: true }, pushAvailability);
slotLockSchema.post("deleteOne", { document: true, query: false }, pushAvailability);

const SlotLock = model<ISlotLock>("SlotLock", slotLockSchema);
export default SlotLock;


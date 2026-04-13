import { Document, Schema, model, Types } from "mongoose";

export interface IDailyTableLock extends Document {
  table: Types.ObjectId;
  date: Date;
  isLocked: boolean;
  reason?: string;
}

const dailyTableLockSchema = new Schema<IDailyTableLock>(
  {
    table: { type: Schema.Types.ObjectId, ref: "Table", required: true },
    date: { type: Date, required: true },
    isLocked: { type: Boolean, default: true },
    reason: { type: String, trim: true, maxlength: 250 }
  },
  { timestamps: true }
);

// Compound index for fast lookup of a table's status on a specific date
dailyTableLockSchema.index({ table: 1, date: 1 }, { unique: true });

const DailyTableLock = model<IDailyTableLock>("DailyTableLock", dailyTableLockSchema);
export default DailyTableLock;

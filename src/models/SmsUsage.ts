import { Document, Schema, model } from "mongoose";

export interface IPhoneLog {
  phone: string;
  timestamp: Date;
  status: string;
}

export interface ISmsUsage extends Document {
  date: string; // Format: YYYY-MM-DD
  count: number;
  phoneLogs: IPhoneLog[];
}

const smsUsageSchema = new Schema<ISmsUsage>(
  {
    date: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    phoneLogs: [
      {
        phone: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        status: { type: String, default: "sent" }
      }
    ]
  },
  { timestamps: true }
);

// Index date for rapid lookups
smsUsageSchema.index({ date: 1 });

const SmsUsage = model<ISmsUsage>("SmsUsage", smsUsageSchema);
export default SmsUsage;

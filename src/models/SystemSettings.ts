import { Document, Schema, Types, Model, model } from "mongoose";

export interface IAuditEntry {
  modifiedBy: Types.ObjectId | string;
  modifiedByName?: string;
  modifiedAt: Date;
  changes: Record<string, { previous: any; current: any }>;
  notes?: string;
}

export interface ISystemSettings extends Document {
  // Ticketing Platform Fee Configuration
  platformFeePercent: number; // e.g. 3.0 (provisional default 3%)
  platformFixedFee: number; // e.g. 0.00
  feeMode: "customer_paid" | "promoter_paid"; // whether fee is added on top or deducted from payout

  // Private Venue Booking Per-Guest Pricing
  perGuestPrice: number; // Default: $50 per guest
  maxGuestCapacity: number; // Default: 40 guests

  // Venue Add-on Rates
  djPrice: number; // Default: $300
  photographerBasePrice: number; // Default: $300 (covers 2 hours)
  photographerExtraHourPrice: number; // Default: $150/hr
  extraHourPrice: number; // Default: $125/hr (beyond 5 hours)
  minDepositAmount: number; // Default: $200

  // Audit History
  auditHistory: IAuditEntry[];

  createdAt: Date;
  updatedAt: Date;
}

const auditEntrySchema = new Schema<IAuditEntry>(
  {
    modifiedBy: { type: Schema.Types.Mixed, required: true },
    modifiedByName: { type: String, trim: true },
    modifiedAt: { type: Date, default: Date.now },
    changes: { type: Schema.Types.Mixed, required: true },
    notes: { type: String, trim: true }
  },
  { _id: false }
);

const systemSettingsSchema = new Schema<ISystemSettings>(
  {
    platformFeePercent: { type: Number, default: 3.0, min: 0, max: 100 },
    platformFixedFee: { type: Number, default: 0.0, min: 0 },
    feeMode: { type: String, enum: ["customer_paid", "promoter_paid"], default: "customer_paid" },

    perGuestPrice: { type: Number, default: 50, min: 1 },
    maxGuestCapacity: { type: Number, default: 40, min: 1 },

    djPrice: { type: Number, default: 300, min: 0 },
    photographerBasePrice: { type: Number, default: 300, min: 0 },
    photographerExtraHourPrice: { type: Number, default: 150, min: 0 },
    extraHourPrice: { type: Number, default: 125, min: 0 },
    minDepositAmount: { type: Number, default: 200, min: 0 },

    auditHistory: [auditEntrySchema]
  },
  { timestamps: true }
);

/**
 * Returns the active singleton settings document or initializes defaults if not present.
 */
systemSettingsSchema.statics.getSettings = async function (): Promise<ISystemSettings> {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({
      platformFeePercent: 3.0,
      platformFixedFee: 0.0,
      feeMode: "customer_paid",
      perGuestPrice: 50,
      maxGuestCapacity: 40,
      djPrice: 300,
      photographerBasePrice: 300,
      photographerExtraHourPrice: 150,
      extraHourPrice: 125,
      minDepositAmount: 200,
      auditHistory: []
    });
  }
  return settings;
};

export interface ISystemSettingsModel extends Model<ISystemSettings> {
  getSettings(): Promise<ISystemSettings>;
}

const SystemSettings = model<ISystemSettings, ISystemSettingsModel>("SystemSettings", systemSettingsSchema);
export default SystemSettings;

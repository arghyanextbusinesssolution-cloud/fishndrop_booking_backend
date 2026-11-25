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

  // Private Venue Booking Pricing — one flat price for the whole venue for the first 5 hours
  venueBasePrice: number; // Default: $800 flat for 5 hours (any guest count up to capacity)
  /** @deprecated Legacy per-guest rate ($50). No longer used for pricing; kept for history. */
  perGuestPrice: number;
  maxGuestCapacity: number; // Default and hard limit: 30 guests (25 seated, up to 30 standing)

  // Venue Add-on Rates
  djPrice: number; // Default: $300
  photographerBasePrice: number; // Default: $300 (covers 2 hours)
  photographerExtraHourPrice: number; // Default: $150/hr
  extraHourPrice: number; // Default: $125/hr (beyond 5 hours)
  minDepositAmount: number; // Default: $300

  // Data migration marker (see getSettings)
  pricingVersion: number;

  // Audit History
  auditHistory: IAuditEntry[];

  createdAt: Date;
  updatedAt: Date;
}

const CURRENT_PRICING_VERSION = 4;

/** The room seats 25; up to 30 standing. No booking or setting may go above 30. */
export const VENUE_SEATED_GUESTS = 25;
export const VENUE_MAX_GUESTS = 30;
export const DEFAULT_VENUE_BASE_PRICE = 800;

const auditEntrySchema =new Schema<IAuditEntry>(
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

    venueBasePrice: { type: Number, default: DEFAULT_VENUE_BASE_PRICE, min: 1 },
    perGuestPrice: { type: Number, default: 50, min: 1 },
    maxGuestCapacity: { type: Number, default: VENUE_MAX_GUESTS, min: 1, max: VENUE_MAX_GUESTS },

    djPrice: { type: Number, default: 300, min: 0 },
    photographerBasePrice: { type: Number, default: 300, min: 0 },
    photographerExtraHourPrice: { type: Number, default: 150, min: 0 },
    extraHourPrice: { type: Number, default: 125, min: 0 },
    minDepositAmount: { type: Number, default: 300, min: 0 },

    pricingVersion: { type: Number, default: 0 },

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
      venueBasePrice: DEFAULT_VENUE_BASE_PRICE,
      perGuestPrice: 50,
      maxGuestCapacity: VENUE_MAX_GUESTS,
      djPrice: 300,
      photographerBasePrice: 300,
      photographerExtraHourPrice: 150,
      extraHourPrice: 125,
      minDepositAmount: 300,
      pricingVersion: CURRENT_PRICING_VERSION,
      auditHistory: []
    });
  }

  // One-time migration: legacy $35/guest rate → $50/guest.
  if ((settings.pricingVersion ?? 0) < CURRENT_PRICING_VERSION) {
    const previous = settings.perGuestPrice;
    if (previous === 35) {
      settings.perGuestPrice = 50;
      settings.auditHistory.push({
        modifiedBy: "system",
        modifiedByName: "System Migration",
        modifiedAt: new Date(),
        changes: { perGuestPrice: { previous, current: 50 } },
        notes: "Per-guest rate updated from $35 to $50"
      });
    }
    // v2: venue deposit minimum raised from $200 to $300
    if (settings.minDepositAmount === 200) {
      settings.minDepositAmount = 300;
      settings.auditHistory.push({
        modifiedBy: "system",
        modifiedByName: "System Migration",
        modifiedAt: new Date(),
        changes: { minDepositAmount: { previous: 200, current: 300 } },
        notes: "Venue minimum deposit updated from $200 to $300"
      });
    }
    // v3: per-guest pricing replaced by a flat venue price ($800) for 5 hours; capacity was 25 seated
    if ((settings.pricingVersion ?? 0) < 3) {
      const changes: Record<string, { previous: any; current: any }> = {};
      if (!settings.venueBasePrice) settings.venueBasePrice = DEFAULT_VENUE_BASE_PRICE;
      changes.pricingModel = {
        previous: `$${settings.perGuestPrice} per guest`,
        current: `$${settings.venueBasePrice} flat for 5 hours`
      };
      if (!settings.maxGuestCapacity || settings.maxGuestCapacity > VENUE_MAX_GUESTS) {
        changes.maxGuestCapacity = { previous: settings.maxGuestCapacity, current: VENUE_MAX_GUESTS };
        settings.maxGuestCapacity = VENUE_MAX_GUESTS;
      }
      settings.auditHistory.push({
        modifiedBy: "system",
        modifiedByName: "System Migration",
        modifiedAt: new Date(),
        changes,
        notes: `Venue pricing changed to a flat $${settings.venueBasePrice} for 5 hours; capacity ${VENUE_SEATED_GUESTS} seated`
      });
    }
    // v4: standing option restored — 25 seated, up to 30 standing
    if ((settings.pricingVersion ?? 0) < 4 && (!settings.maxGuestCapacity || settings.maxGuestCapacity === VENUE_SEATED_GUESTS)) {
      const previous = settings.maxGuestCapacity;
      settings.maxGuestCapacity = VENUE_MAX_GUESTS;
      settings.auditHistory.push({
        modifiedBy: "system",
        modifiedByName: "System Migration",
        modifiedAt: new Date(),
        changes: { maxGuestCapacity: { previous, current: VENUE_MAX_GUESTS } },
        notes: `Standing option restored: ${VENUE_SEATED_GUESTS} seated, up to ${VENUE_MAX_GUESTS} standing`
      });
    }
    settings.pricingVersion = CURRENT_PRICING_VERSION;
    await settings.save();
  }
  // Never let a hand-edited value exceed the room
  if (!settings.maxGuestCapacity || settings.maxGuestCapacity > VENUE_MAX_GUESTS) settings.maxGuestCapacity = VENUE_MAX_GUESTS;
  if (!settings.venueBasePrice) settings.venueBasePrice = DEFAULT_VENUE_BASE_PRICE;
  return settings;
};

/**
 * Venue rental before add-ons: one flat price for the first 5 hours + each extra hour.
 * The guest count does not change the price (it only has to fit the room: 25 seated / 30 standing).
 */
export const venueRentalCost = (
  s: { venueBasePrice?: number; extraHourPrice?: number },
  durationHours: number
): { base: number; extraHours: number; extraHoursCost: number } => {
  const base = s.venueBasePrice || DEFAULT_VENUE_BASE_PRICE;
  const extraHours = Math.max(0, durationHours - 5);
  return { base, extraHours, extraHoursCost: extraHours * (s.extraHourPrice ?? 125) };
};

export interface ISystemSettingsModel extends Model<ISystemSettings> {
  getSettings(): Promise<ISystemSettings>;
}

const SystemSettings = model<ISystemSettings, ISystemSettingsModel>("SystemSettings", systemSettingsSchema);
export default SystemSettings;

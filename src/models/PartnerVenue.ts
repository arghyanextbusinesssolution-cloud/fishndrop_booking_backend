import { Document, Schema, Types, model } from "mongoose";

/**
 * A third-party venue listed on the Tropica marketplace ("Explore Venues").
 * Sarah (staff) manages the listing; the venue owner (role "venue_owner") can only edit
 * the brand theme + media and connect their Stripe account.
 */

export interface IVenuePackage {
  _id?: Types.ObjectId;
  name: string;
  price: number;
  hours: number;
  description?: string;
}

/** Opening hours for one weekday (0 = Sunday). closeTime at/before openTime = closes after midnight. */
export interface IVenueDayHours {
  day: number;
  open: boolean;
  openTime: string;
  closeTime: string;
}

export interface IVenueTheme {
  primary: string;
  primaryContainer: string;
  onPrimary: string;
  background: string;
  surface: string;
  onSurface: string;
  accent: string;
}

export interface IPartnerVenue extends Document {
  name: string;
  slug: string;
  tagline?: string;
  description: string;
  address: string;
  neighborhood?: string;
  city?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  venueType: string;
  amenities: string[];
  rules: string[];
  cancellationPolicy?: string;
  minGuests: number;
  maxGuests: number;

  pricingMode: "hourly" | "flat";
  basePrice: number;
  minHours: number;
  packages: IVenuePackage[];
  partnerDiscountPct: number;
  customerDiscountPct: number;
  depositPct: number;

  openTime: string;
  closeTime: string;
  slotStepMins: number;
  operatingDays: number[];
  /** Per-day hours (source of truth when present). openTime/closeTime/operatingDays mirror it for older code. */
  weeklyHours: IVenueDayHours[];

  theme: IVenueTheme;
  logoUrl?: string;
  flyerUrl?: string;
  coverUrl?: string;
  photos: string[];

  ownerName?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  ownerUser?: Types.ObjectId;

  stripeConnectAccountId?: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  stripeConnectOnboarded: boolean;

  status: "draft" | "published" | "paused";
  agreementSignedAt?: Date;
  internalNotes?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_VENUE_THEME: IVenueTheme = {
  primary: "#E3C281",
  primaryContainer: "#0F3D2E",
  onPrimary: "#0F3D2E",
  background: "#0F3D2E",
  surface: "#16553F",
  onSurface: "#FFFFFF",
  accent: "#A2D1BB"
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const hexField = (fallback: string) => ({
  type: String,
  default: fallback,
  validate: { validator: (v: string) => HEX.test(v), message: "Theme colors must be #RRGGBB" }
});

const packageSchema = new Schema<IVenuePackage>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    price: { type: Number, required: true, min: 0 },
    hours: { type: Number, required: true, min: 1, max: 24 },
    description: { type: String, trim: true, maxlength: 300 }
  },
  { _id: true }
);

const themeSchema = new Schema<IVenueTheme>(
  {
    primary: hexField(DEFAULT_VENUE_THEME.primary),
    primaryContainer: hexField(DEFAULT_VENUE_THEME.primaryContainer),
    onPrimary: hexField(DEFAULT_VENUE_THEME.onPrimary),
    background: hexField(DEFAULT_VENUE_THEME.background),
    surface: hexField(DEFAULT_VENUE_THEME.surface),
    onSurface: hexField(DEFAULT_VENUE_THEME.onSurface),
    accent: hexField(DEFAULT_VENUE_THEME.accent)
  },
  { _id: false }
);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const dayHoursSchema = new Schema<IVenueDayHours>(
  {
    day: { type: Number, required: true, min: 0, max: 6 },
    open: { type: Boolean, default: true },
    openTime: { type: String, default: "12:00", match: HHMM },
    closeTime: { type: String, default: "23:00", match: HHMM }
  },
  { _id: false }
);

/** The 7-day schedule for a venue, falling back to the legacy single open/close + open days. */
export const resolveWeeklyHours = (
  v: Pick<IPartnerVenue, "weeklyHours" | "openTime" | "closeTime" | "operatingDays">
): IVenueDayHours[] => {
  if (v.weeklyHours?.length === 7) {
    return [...v.weeklyHours]
      .map((d) => ({ day: d.day, open: d.open, openTime: d.openTime, closeTime: d.closeTime }))
      .sort((a, b) => a.day - b.day);
  }
  const days = v.operatingDays?.length ? v.operatingDays : [0, 1, 2, 3, 4, 5, 6];
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    open: days.includes(day),
    openTime: v.openTime || "12:00",
    closeTime: v.closeTime || "23:00"
  }));
};

const partnerVenueSchema = new Schema<IPartnerVenue>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    tagline: { type: String, trim: true, maxlength: 160 },
    description: { type: String, default: "", maxlength: 5000 },
    address: { type: String, default: "", trim: true },
    neighborhood: { type: String, trim: true },
    city: { type: String, trim: true, default: "New York" },
    lat: { type: Number },
    lng: { type: Number },
    placeId: { type: String },
    venueType: { type: String, default: "event_space", trim: true },
    amenities: { type: [String], default: [] },
    rules: { type: [String], default: [] },
    cancellationPolicy: { type: String, maxlength: 2000 },
    minGuests: { type: Number, default: 1, min: 1 },
    maxGuests: { type: Number, default: 50, min: 1 },

    pricingMode: { type: String, enum: ["hourly", "flat"], default: "hourly" },
    basePrice: { type: Number, default: 0, min: 0 },
    minHours: { type: Number, default: 2, min: 1, max: 24 },
    packages: { type: [packageSchema], default: [] },
    partnerDiscountPct: { type: Number, default: 0, min: 0, max: 100 },
    customerDiscountPct: { type: Number, default: 0, min: 0, max: 100 },
    depositPct: { type: Number, default: 100, min: 1, max: 100 },

    openTime: { type: String, default: "10:00", match: HHMM },
    closeTime: { type: String, default: "23:00", match: HHMM },
    slotStepMins: { type: Number, default: 60, enum: [30, 60] },
    operatingDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
    weeklyHours: { type: [dayHoursSchema], default: undefined },

    theme: { type: themeSchema, default: () => ({ ...DEFAULT_VENUE_THEME }) },
    logoUrl: { type: String },
    flyerUrl: { type: String },
    coverUrl: { type: String },
    photos: { type: [String], default: [] },

    ownerName: { type: String, trim: true },
    ownerEmail: { type: String, trim: true, lowercase: true },
    ownerPhone: { type: String, trim: true },
    ownerUser: { type: Schema.Types.ObjectId, ref: "User" },

    stripeConnectAccountId: { type: String, index: true, sparse: true },
    chargesEnabled: { type: Boolean, default: false },
    payoutsEnabled: { type: Boolean, default: false },
    stripeConnectOnboarded: { type: Boolean, default: false },

    status: { type: String, enum: ["draft", "published", "paused"], default: "draft", index: true },
    agreementSignedAt: { type: Date },
    internalNotes: { type: String, maxlength: 5000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

partnerVenueSchema.pre("validate", function () {
  // Keep the legacy summary fields in sync with the per-day schedule.
  if (this.weeklyHours?.length === 7) {
    const openDays = this.weeklyHours.filter((d) => d.open);
    this.operatingDays = openDays.map((d) => d.day).sort();
    if (openDays[0]) {
      this.openTime = openDays.reduce((m, d) => (d.openTime < m ? d.openTime : m), openDays[0].openTime);
      this.closeTime = openDays[0].closeTime;
    }
  }
  if (this.minGuests > this.maxGuests) {
    this.invalidate("minGuests", "minGuests cannot exceed maxGuests");
  }
});

/** Fields a venue owner may change from the partner portal. Everything else is staff-managed. */
export const OWNER_EDITABLE_FIELDS = ["theme", "logoUrl", "flyerUrl", "coverUrl", "photos"] as const;
/** Commercial terms only admin/owner (not staff) may change. */
export const ADMIN_ONLY_FIELDS = ["partnerDiscountPct", "customerDiscountPct", "depositPct"] as const;

const PartnerVenue = model<IPartnerVenue>("PartnerVenue", partnerVenueSchema);
export default PartnerVenue;

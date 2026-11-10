import { Document, Schema, Types, model } from "mongoose";

export interface ITicketTier {
  _id?: Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
  sold: number;
  reserved: number;
  salesDeadline?: Date;
  description?: string;
}

export interface IEvent extends Document {
  promoter: Types.ObjectId;
  title: string;
  slug: string;
  description: string;
  date: Date;
  startTime: string;
  endTime: string;
  venueType: "tropica" | "external";
  venueName: string;
  venueAddress: string;
  venueLat?: number;
  venueLng?: number;
  venuePlaceId?: string;
  flyerUrl: string;
  ticketTiers: ITicketTier[];
  status: "draft" | "pending_approval" | "published" | "cancelled" | "completed";
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
  feeOverridePercent?: number;
  fixedFeeOverride?: number;
  feeModeOverride?: "customer_paid" | "promoter_paid";
  createdAt: Date;
  updatedAt: Date;
}

const ticketTierSchema = new Schema<ITicketTier>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    sold: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    salesDeadline: { type: Date },
    description: { type: String, trim: true, maxlength: 200 }
  },
  { timestamps: true }
);

const eventSchema = new Schema<IEvent>(
  {
    promoter: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    description: { type: String, required: true, trim: true, maxlength: 3000 },
    date: { type: Date, required: true, index: true },
    startTime: { type: String, required: true, trim: true },
    endTime: { type: String, required: true, trim: true },
    venueType: { type: String, enum: ["tropica", "external"], default: "tropica" },
    venueName: { type: String, required: true, trim: true, maxlength: 100 },
    venueAddress: { type: String, required: true, trim: true, maxlength: 200 },
    venueLat: { type: Number, min: -90, max: 90 },
    venueLng: { type: Number, min: -180, max: 180 },
    venuePlaceId: { type: String, trim: true, maxlength: 300 },
    flyerUrl: { type: String, required: true, trim: true },
    ticketTiers: [ticketTierSchema],
    status: {
      type: String,
      enum: ["draft", "pending_approval", "published", "cancelled", "completed"],
      default: "draft",
      index: true
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 500 },
    feeOverridePercent: { type: Number, min: 0, max: 100 },
    fixedFeeOverride: { type: Number, min: 0 },
    feeModeOverride: { type: String, enum: ["customer_paid", "promoter_paid"] }
  },
  { timestamps: true }
);

export const generateEventSlug = (title: string, dateStr?: string): string => {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
  const suffix = Math.random().toString(36).substring(2, 7);
  return `${base}-${suffix}`;
};

const Event = model<IEvent>("Event", eventSchema);
export default Event;


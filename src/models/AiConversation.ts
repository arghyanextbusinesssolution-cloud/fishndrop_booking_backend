import { Document, Schema, model } from "mongoose";

/**
 * One social conversation (Instagram / Facebook DM via GHL) handled by the Tropica AI booking assistant.
 * Holds the chat memory, the inquiry details collected so far and the human-handoff state.
 * Bookings themselves stay in the Booking collection — this is only the inquiry.
 */

export type AiInquiryStage =
  | "new"
  | "collecting_details"
  | "availability_checked"
  | "link_shared"
  | "human_required"
  | "closed";

export interface IAiMessage {
  role: "user" | "assistant" | "staff";
  content: string;
  at: Date;
  messageId?: string;
}

export interface IAiInquiry {
  bookingType?: "venue" | "table" | "event" | "unknown";
  date?: string; // YYYY-MM-DD (New York)
  startTime?: string; // HH:MM 24h
  durationHours?: number;
  guests?: number;
  occasion?: string;
}

export interface IAiLastCheck {
  kind: "venue" | "table";
  date: string;
  startTime?: string;
  durationHours?: number;
  guests?: number;
  available: boolean;
  summary: string;
  checkedAt: Date;
}

export interface IAiHold {
  bookingId: string;
  ref: string;
  paymentUrl: string;
  expiresAt: Date;
  deposit: number;
  total: number;
  status: "awaiting_payment" | "confirmed" | "expired" | "cancelled" | "paid_needs_review";
}

export interface IAiConversation extends Document {
  contactId: string;
  channel: string; // instagram | facebook | test | other
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  hold?: IAiHold;
  callback?: {
    phone?: string;
    reason?: string;
    bestTime?: string;
    requestedAt?: Date;
    lastFollowUpAt?: Date;
    status?: "requested" | "chat_only";
  };
  messages: IAiMessage[];
  inquiry: IAiInquiry;
  lastCheck?: IAiLastCheck;
  stage: AiInquiryStage;
  aiPaused: boolean;
  pausedReason?: string;
  pausedAt?: Date;
  pausedBy?: string;
  linkSharedAt?: Date;
  processedMessageIds: string[];
  lastInboundAt?: Date;
  lastReplyAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IAiMessage>(
  {
    role: { type: String, enum: ["user", "assistant", "staff"], required: true },
    content: { type: String, required: true },
    at: { type: Date, default: Date.now },
    messageId: { type: String }
  },
  { _id: false }
);

const aiConversationSchema = new Schema<IAiConversation>(
  {
    contactId: { type: String, required: true, unique: true, index: true },
    channel: { type: String, default: "instagram" },
    contactName: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    contactPhone: { type: String, trim: true },
    hold: {
      bookingId: String,
      ref: String,
      paymentUrl: String,
      expiresAt: Date,
      deposit: Number,
      total: Number,
      status: { type: String, enum: ["awaiting_payment", "confirmed", "expired", "cancelled", "paid_needs_review"] }
    },
    callback: {
      phone: String,
      reason: String,
      bestTime: String,
      requestedAt: Date,
      lastFollowUpAt: Date,
      status: { type: String, enum: ["requested", "chat_only"] }
    },
    messages: { type: [messageSchema], default: [] },
    inquiry: {
      bookingType: { type: String, enum: ["venue", "table", "event", "unknown"] },
      date: String,
      startTime: String,
      durationHours: Number,
      guests: Number,
      occasion: String
    },
    lastCheck: {
      kind: { type: String, enum: ["venue", "table"] },
      date: String,
      startTime: String,
      durationHours: Number,
      guests: Number,
      available: Boolean,
      summary: String,
      checkedAt: Date
    },
    stage: {
      type: String,
      enum: ["new", "collecting_details", "availability_checked", "link_shared", "human_required", "closed"],
      default: "new"
    },
    aiPaused: { type: Boolean, default: false },
    pausedReason: String,
    pausedAt: Date,
    pausedBy: String,
    linkSharedAt: Date,
    processedMessageIds: { type: [String], default: [] },
    lastInboundAt: Date,
    lastReplyAt: Date
  },
  { timestamps: true }
);

aiConversationSchema.index({ updatedAt: -1 });

export default model<IAiConversation>("AiConversation", aiConversationSchema);

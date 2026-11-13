export type NormalizedStatus = "lead" | "pending_payment" | "confirmed" | "rescheduled" | "canceled" | "completed";

export type BookingEventName =
  | "lead_created"
  | "booking_confirmed"
  | "booking_canceled"
  | "booking_rescheduled"
  | "guest_media_uploaded"
  | "zelle_payment_submitted"
  | "zelle_payment_confirmed"
  | "booking_sync";

export type BookingLeadStatus = "lead" | "booking" | "canceled" | "rescheduled";

export type BookingGHLTag =
  | "Website Lead"
  | "Booking Confirmed"
  | "Booking Canceled"
  | "Booking Rescheduled"
  | "Media Uploaded"
  | "Zelle Payment Pending"
  | "Zelle Payment Confirmed"
  | "Booking Updated";

export interface MediaDetails {
  mediaUrls?: string[];
  photoCount?: number;
  videoCount?: number;
  marketingConsent?: boolean;
}

export interface GHLPayloadOptions {
  event: BookingEventName;
  leadStatus: BookingLeadStatus;
  ghlTag: BookingGHLTag;
  reason?: string;
  paidNow?: number;
  previousBookingDate?: string;
  previousBookingTime?: string;
  mediaDetails?: MediaDetails;
}

export interface PaidNowExtra {
  paidNow?: number;
}

export interface PreviousSchedule {
  previousBookingDate?: string;
  previousBookingTime?: string;
}

export interface ActorInfo {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
}

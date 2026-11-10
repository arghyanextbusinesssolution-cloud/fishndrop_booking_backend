/**
 * GHL (LeadConnector) outbound webhook integration.
 *
 *   config.ts                    webhook URL registry + client tuning (env driven)
 *   client.ts                    HTTP dispatch: timeout, retries w/ backoff, never throws
 *   payloads/booking.payload.ts  shared booking payload builder
 *   helpers/*                    pure helpers (time, payments, catering, status)
 *   triggers/<domain>/*.trigger.ts  one file per GHL trigger
 *
 * Import from this barrel only: `import { sendGHLLeadEvent } from "../integrations/ghl"`.
 */

// Booking lifecycle
export { sendGHLLeadEvent } from "./triggers/booking/leadCreated.trigger";
export { sendGHLBookingEvent } from "./triggers/booking/bookingConfirmed.trigger";
export { sendGHLRescheduleEvent } from "./triggers/booking/bookingRescheduled.trigger";
export { sendGHLCancelEvent } from "./triggers/booking/bookingCanceled.trigger";
export { sendGHLMediaUploadEvent } from "./triggers/booking/guestMediaUploaded.trigger";
export { sendGHLZellePendingEvent } from "./triggers/booking/zellePaymentSubmitted.trigger";
export { sendGHLZelleConfirmedEvent } from "./triggers/booking/zellePaymentConfirmed.trigger";

// Promoters
export { sendGHLPromoterRegisteredEvent } from "./triggers/promoter/promoterRegistered.trigger";
export {
  sendGHLPromoterVerificationEvent,
  sendGHLPromoterApprovedEvent
} from "./triggers/promoter/promoterVerification.trigger";
export type { PromoterVerificationAction } from "./triggers/promoter/promoterVerification.trigger";

// Events
export { sendGHLEventApprovedEvent } from "./triggers/event/eventApproved.trigger";
export { sendGHLPromoterEventCreatedEvent } from "./triggers/event/promoterEventCreated.trigger";

// Tickets
export { sendGHLTicketPurchasedEvent } from "./triggers/ticket/ticketPurchased.trigger";
export { sendGHLTicketCheckedInEvent } from "./triggers/ticket/ticketCheckedIn.trigger";
export { sendGHLTicketGuestEvent } from "./triggers/ticket/ticketGuest.trigger";
export type { TicketGuestAction, TicketGuestInfo } from "./triggers/ticket/ticketGuest.trigger";

// Private-event guest passes
export { sendGHLGuestPassIssuedEvent } from "./triggers/guestPass/guestPassIssued.trigger";
export { sendGHLGuestPassCheckedInEvent } from "./triggers/guestPass/guestPassCheckedIn.trigger";
export { sendGHLGuestPassCancelledEvent } from "./triggers/guestPass/guestPassCancelled.trigger";

// Staff
export { sendGHLEmployeeCreatedEvent } from "./triggers/employee/employeeCreated.trigger";

// Shared utilities used outside the integration
export { calculateEventTimes, getNewYorkUtcDate } from "./helpers/time";
export { normalizeBookingStatus } from "./helpers/status";
export { CATERING_LABEL_MAP } from "./helpers/catering";
export { buildBookingPayload } from "./payloads/booking.payload";
export { dispatchToGHL } from "./client";
export type { DispatchResult } from "./client";
export type * from "./types";

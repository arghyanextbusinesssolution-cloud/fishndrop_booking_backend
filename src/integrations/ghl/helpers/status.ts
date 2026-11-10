import type { NormalizedStatus } from "../types";

/**
 * Standardizes booking status spelling across the app and webhooks
 * (e.g. "cancelled" → "canceled").
 */
export const normalizeBookingStatus = (status?: string): NormalizedStatus => {
  const s = (status || "").toLowerCase().trim();
  if (s === "cancelled" || s === "canceled" || s === "cancel") return "canceled";
  if (s === "rescheduled" || s === "reschedule") return "rescheduled";
  if (s === "confirmed" || s === "confirm") return "confirmed";
  if (s === "pending_payment" || s === "deposit_paid") return "pending_payment";
  if (s === "completed" || s === "complete") return "completed";
  return "lead";
};

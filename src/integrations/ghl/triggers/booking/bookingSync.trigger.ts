import { safeTrigger } from "../../client";
import { buildBookingPayload } from "../../payloads/booking.payload";
import { resolveRestaurantName, parseBookingNotes } from "../../helpers/catering";
import { calculateEventTimes, toDateOnly } from "../../helpers/time";
import { shortRef, toId } from "../../helpers/common";
import { VENUE_NAME } from "../../config";

export type BookingSyncChange = "new" | "updated" | "cancelled" | "rescheduled" | "payment_updated";

export interface BookingSyncInfo {
  changeType: BookingSyncChange;
  changedFields?: string[];
}

/** "2026-11-25" → "Wednesday, November 25, 2026" — local to the AI summary (the shared helper is left untouched). */
const summaryDate = (dateOnly: string): string => {
  if (!dateOnly) return "";
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
};

const money = (n: unknown) => `$${(Number(n) || 0).toFixed(2).replace(/\.00$/, "")}`;
const nice = (s: unknown) => String(s || "").replace(/_/g, " ");

const PAY_METHOD_LABEL: Record<string, string> = {
  card: "card",
  zelle: "Zelle",
  cash: "cash",
  bank_transfer: "bank transfer",
  other: "other"
};

/** Amount actually collected, matching what the admin panel shows (total − remaining). */
const paidOf = (b: any) => Math.max(0, (Number(b.totalAmount) || 0) - (Number(b.remainingAmount) || 0));

/**
 * One plain-English paragraph describing the booking — the field GHL Conversation AI reads
 * to answer "when is my booking / how much do I owe?" in Instagram & TikTok chats.
 */
export const buildAiBookingSummary = (b: any): string => {
  const isPrivate = b.bookingType === "private_event";
  const dateOnly = toDateOnly(b.bookingDate);
  const hours = Number(b.durationHours) || (isPrivate ? 5 : 2);
  const { eventStartTime, eventEndTime } = calculateEventTimes(dateOnly, b.bookingTime || "", hours);
  const status = b.status === "cancelled" ? "CANCELLED" : b.status === "confirmed" ? "confirmed" : "pending confirmation";
  const ref = shortRef(toId(b) || "");

  const total = Number(b.totalAmount) || 0;
  const paid = paidOf(b);
  const remaining = Math.max(0, Number(b.remainingAmount) || 0);
  const method = PAY_METHOD_LABEL[b.paymentMethod] || "card";

  const parts: string[] = [];
  parts.push(
    `${b.customerName || "The customer"} has a ${status} ${isPrivate ? "private venue (full buyout) booking" : "table reservation"} at ${VENUE_NAME} (booking #${ref}) on ${summaryDate(dateOnly)}, ${eventStartTime}${eventEndTime ? `–${eventEndTime}` : ""} (${hours} hours) for ${b.partySize || "?"} guests${b.occasion ? `, occasion: ${nice(b.occasion)}` : ""}.`
  );

  if (b.status !== "cancelled") {
    const payBits = [`Total ${money(total)}`, `paid ${money(paid)}`];
    payBits.push(remaining > 0 ? `balance ${money(remaining)} still due` : "fully paid, nothing due");
    let payLine = `${payBits.join(", ")}. Payment method: ${method}`;
    if (b.paymentMethod === "zelle" && b.zelleVerificationStatus && b.zelleVerificationStatus !== "none") {
      payLine += ` (Zelle ${nice(b.zelleVerificationStatus)})`;
    }
    parts.push(`${payLine}.`);
  } else if (b.cancellationReason) {
    parts.push(`Cancellation reason: ${b.cancellationReason}.`);
  }

  if (isPrivate) {
    const addOns: string[] = [];
    addOns.push(b.needDj ? "DJ included" : "no DJ");
    addOns.push(b.needPhotographer ? `photographer for ${b.photographerHours || 2} hours` : "no photographer");
    const notes = parseBookingNotes(b.notes, b.dishQuantities);
    const hasCatering = b.cateringMenu && !["none", "no_catering"].includes(b.cateringMenu);
    addOns.push(
      hasCatering
        ? `catering: ${resolveRestaurantName(b.cateringMenu)}${notes.dishesSummary ? ` — ${notes.dishesSummary}` : ""}`
        : "no partner catering (self-managed food)"
    );
    parts.push(`Add-ons: ${addOns.join(", ")}.`);
    if (notes.dietaryNotes) parts.push(`Dietary notes: ${notes.dietaryNotes}.`);
  }

  if (b.complimentaryDrinks) parts.push(`${b.complimentaryDrinks} complimentary drinks included.`);
  if (b.rescheduledAt) parts.push("This booking has been rescheduled before.");
  return parts.join(" ");
};

/**
 * Full booking snapshot, sent whenever a completed booking is created or changed
 * (fired automatically from the Booking model's post-save hook).
 * Event: "booking_sync" · Tag: "Booking Updated" · Webhook: bookingSync
 */
export const sendGHLBookingSyncEvent = async (booking: any, info: BookingSyncInfo): Promise<void> => {
  await safeTrigger("booking_sync", () => {
    const isPrivate = booking.bookingType === "private_event";
    const hours = Number(booking.durationHours) || (isPrivate ? 5 : 2);
    const { eventEndTime } = calculateEventTimes(toDateOnly(booking.bookingDate), booking.bookingTime || "", hours);
    return {
      webhook: "bookingSync",
      event: "booking_sync",
      ref: `#${shortRef(toId(booking) || "")}`,
      payload: {
        ...buildBookingPayload(booking, {
          event: "booking_sync",
          leadStatus: booking.status === "cancelled" ? "canceled" : "booking",
          ghlTag: "Booking Updated"
        }),
        changeType: info.changeType,
        changedFields: info.changedFields || [],
        blocksVenue: isPrivate && booking.status !== "cancelled",
        bookingEndTime: eventEndTime,
        amountPaid: paidOf(booking),
        balanceDue: Math.max(0, Number(booking.remainingAmount) || 0),
        aiBookingSummary: buildAiBookingSummary(booking)
      }
    };
  });
};

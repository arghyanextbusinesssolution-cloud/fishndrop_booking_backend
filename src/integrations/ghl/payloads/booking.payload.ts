import { getBookingFrontendUrl, getReviewUrl, GHLWebhookKey, VENUE_NAME } from "../config";
import { employeeFields, getEmployeeContacts } from "../helpers/team";
import type { DispatchOptions } from "../client";
import type { GHLPayloadOptions, NormalizedStatus } from "../types";
import { parseBookingNotes, resolveRestaurantName } from "../helpers/catering";
import { shortRef, splitName, toId } from "../helpers/common";
import { summarizePayments } from "../helpers/payments";
import { normalizeBookingStatus } from "../helpers/status";
import { calculateEventTimes, formatLongDate, toDateOnly, toIsoOrEmpty } from "../helpers/time";

const resolveStatus = (booking: any, event: GHLPayloadOptions["event"]): NormalizedStatus => {
  if (event === "booking_canceled") return "canceled";
  if (event === "booking_rescheduled") return "rescheduled";
  return normalizeBookingStatus(booking.status);
};

const formatTables = (tables: unknown): string => {
  if (Array.isArray(tables)) {
    return tables.map((t: any) => (typeof t === "object" ? t.tableNumber || t.name || t._id : String(t))).join(", ");
  }
  return tables ? String(tables) : "";
};

const countMedia = (booking: any, type: "photo" | "video"): number =>
  Array.isArray(booking.guestMedia) ? booking.guestMedia.filter((m: any) => m.mediaType === type).length : 0;

/**
 * Builds the full booking payload shared by all booking lifecycle triggers.
 *
 * NOTE: field names (both camelCase and snake_case) are consumed by GHL workflows and
 * custom-field mappings — do not rename or remove fields without updating GHL.
 */
export const buildBookingPayload = (booking: any, options: GHLPayloadOptions) => {
  const bookingId = toId(booking) || String(booking);
  const shortBookingId = shortRef(bookingId);
  const isReschedule = options.event === "booking_rescheduled";

  const rawDateStr = toDateOnly(booking.bookingDate);
  const durationHours = Number(booking.durationHours) || (booking.bookingType === "private_event" ? 5 : 2);
  const { eventStartTime, eventEndTime, eventStartIso, eventEndIso, timezone } = calculateEventTimes(
    rawDateStr,
    booking.bookingTime || "",
    durationHours
  );
  const formattedDate = formatLongDate(rawDateStr);

  const { name, firstName, lastName } = splitName(booking.customerName);
  const email = String(booking.customerEmail || "").trim().toLowerCase();
  const phone = String(booking.customerPhone || "").trim();

  const normalizedStatus = resolveStatus(booking, options.event);
  const pay = summarizePayments(booking, options.paidNow);
  const tableStr = formatTables(booking.tables);

  const uploadUrl = `${getBookingFrontendUrl()}/upload?bookingId=${bookingId}`;
  const thankYouUrl = uploadUrl;
  const reviewUrl = getReviewUrl();

  const mediaUrls =
    options.mediaDetails?.mediaUrls || (Array.isArray(booking.guestMedia) ? booking.guestMedia.map((m: any) => m.url) : []);
  const marketingConsent = options.mediaDetails?.marketingConsent ?? Boolean(booking.marketingConsent);
  const consentLabel = marketingConsent ? "Granted" : "Denied";

  const previousEventEndIso =
    options.previousBookingDate && options.previousBookingTime
      ? calculateEventTimes(options.previousBookingDate, options.previousBookingTime, durationHours).eventEndIso
      : "";
  const previousBookingDate = options.previousBookingDate || booking.previousBookingDate || "";
  const previousBookingTime = options.previousBookingTime || booking.previousBookingTime || "";
  const isRescheduled = isReschedule || Boolean(booking.rescheduledAt);

  const restaurantName = resolveRestaurantName(booking.cateringMenu);
  const cateringMenu = booking.cateringMenu || "none";
  const notes = parseBookingNotes(booking.notes, booking.dishQuantities);

  const utm = {
    utmSource: booking.utmSource || "",
    utmMedium: booking.utmMedium || "",
    utmCampaign: booking.utmCampaign || "",
    utmContent: booking.utmContent || "",
    utmTerm: booking.utmTerm || "",
    fbclid: booking.fbclid || ""
  };

  const totalAmount = Number(booking.totalAmount || 0);
  const remainingAmount = Number(booking.remainingAmount || 0);
  const startTimeOrRaw = eventStartTime || booking.bookingTime || "";

  // Dictionary for direct GHL contact custom-field mapping
  const contactCustomFields: Record<string, unknown> = {
    bookingId,
    booking_id: bookingId,
    shortBookingId: `#${shortBookingId}`,
    eventDate: rawDateStr,
    event_date: rawDateStr,
    eventDateFormatted: formattedDate,
    event_date_formatted: formattedDate,
    eventStartTime,
    event_start_time: eventStartTime,
    eventEndTime,
    event_end_time: eventEndTime,
    eventStartIso,
    event_start_iso: eventStartIso,
    eventEndIso,
    event_end_iso: eventEndIso,
    durationHours,
    duration_hours: durationHours,
    timezone,
    venueName: VENUE_NAME,
    bookingStatus: normalizedStatus,
    booking_status: normalizedStatus,
    uploadUrl,
    upload_url: uploadUrl,
    thankYouUrl,
    thank_you_url: thankYouUrl,
    reviewUrl,
    review_url: reviewUrl,
    marketingConsent: consentLabel,
    marketing_consent: consentLabel,
    restaurantName,
    restaurant_name: restaurantName,
    cateringMenu,
    catering_menu: cateringMenu,
    dishesSummary: notes.dishesSummary,
    dishes_summary: notes.dishesSummary,
    dishesList: notes.dishesSummary,
    dishes_list: notes.dishesSummary,
    dishCount: notes.totalDishCount,
    dish_count: notes.totalDishCount,
    dietaryNotes: notes.dietaryNotes,
    dietary_notes: notes.dietaryNotes,
    customerNotes: notes.cleanNotes,
    customer_notes: notes.cleanNotes,
    utmSource: utm.utmSource,
    utm_source: utm.utmSource,
    utmCampaign: utm.utmCampaign,
    utm_campaign: utm.utmCampaign,
    utmMedium: utm.utmMedium,
    utm_medium: utm.utmMedium,
    utmContent: utm.utmContent,
    utm_content: utm.utmContent,
    utmTerm: utm.utmTerm,
    fbclid: utm.fbclid,
    isRescheduled,
    previousBookingDate,
    previousBookingTime,
    previousEventEndIso,
    previous_event_end_iso: previousEventEndIso
  };

  return {
    // ── Primary event & customer identity
    event: options.event,
    leadStatus: options.leadStatus,
    ghlTag: options.ghlTag,
    customerName: name,
    name,
    full_name: name,
    firstName,
    first_name: firstName,
    lastName,
    last_name: lastName,
    customerEmail: email,
    email,
    customerPhone: phone,
    phone,

    // ── Standardized status
    status: normalizedStatus,
    bookingStatus: normalizedStatus,
    booking_status: normalizedStatus,
    cancellationReason: options.reason || booking.cancellationReason || "",

    // ── Booking identity & schedule
    bookingId,
    booking_id: bookingId,
    shortBookingId: `#${shortBookingId}`,
    bookingDate: rawDateStr,
    eventDate: rawDateStr,
    event_date: rawDateStr,
    eventDateFormatted: formattedDate,
    event_date_formatted: formattedDate,
    bookingTime: booking.bookingTime || "",
    eventTime: startTimeOrRaw,
    eventStartTime: startTimeOrRaw,
    event_start_time: startTimeOrRaw,
    eventEndTime,
    event_end_time: eventEndTime,

    // ── Timezone-aware ISO datetimes (America/New_York)
    eventStartIso,
    event_start_iso: eventStartIso,
    eventEndIso,
    event_end_iso: eventEndIso,
    timezone,
    timeZone: timezone,

    durationHours,
    duration_hours: durationHours,
    partySize: booking.partySize || 1,
    bookingType: booking.bookingType || "standard",
    venueName: VENUE_NAME,
    tables: tableStr,
    tableNumbers: tableStr,

    // ── Reschedule & automation reset signals
    isRescheduled,
    previousBookingDate,
    previousBookingTime,
    previousEventEndIso,
    previous_event_end_iso: previousEventEndIso,
    rescheduledAt: toIsoOrEmpty(booking.rescheduledAt),
    rescheduleCount: Number(booking.rescheduleCount || (isReschedule ? 1 : 0)),
    workflowAction: isReschedule ? "reset_post_event_workflow" : undefined,
    resetInstructions: isReschedule
      ? "Remove contact from old post-event workflow -> update event_end_iso -> re-add contact to workflow"
      : undefined,
    addTags: isReschedule ? ["Booking Rescheduled", "Rescheduled Reset Needed"] : [options.ghlTag],
    removeTags: isReschedule
      ? ["Booking Confirmed"]
      : options.event === "booking_canceled"
      ? ["Booking Confirmed", "Booking Rescheduled"]
      : [],

    // ── Post-event thank-you & review
    uploadUrl,
    upload_url: uploadUrl,
    thankYouUrl,
    thank_you_url: thankYouUrl,
    reviewUrl,
    review_url: reviewUrl,

    // ── Guest media & marketing consent
    mediaUrls,
    media_urls: mediaUrls,
    photoCount: options.mediaDetails?.photoCount ?? countMedia(booking, "photo"),
    videoCount: options.mediaDetails?.videoCount ?? countMedia(booking, "video"),
    marketingConsent,
    marketing_consent: consentLabel,

    // ── Attribution (Instagram / Meta ads)
    utmSource: utm.utmSource,
    utm_source: utm.utmSource,
    utmMedium: utm.utmMedium,
    utm_medium: utm.utmMedium,
    utmCampaign: utm.utmCampaign,
    utm_campaign: utm.utmCampaign,
    utmContent: utm.utmContent,
    utm_content: utm.utmContent,
    utmTerm: utm.utmTerm,
    fbclid: utm.fbclid,
    fbc: booking.fbc || "",
    fbp: booking.fbp || "",
    referralUrl: booking.referralUrl || "",

    // ── GHL custom-fields dictionary
    customFields: contactCustomFields,
    custom_fields: contactCustomFields,

    // ── Financials & installments
    totalAmount,
    total_amount: totalAmount,
    depositInStart: pay.depositInStart,
    deposit_in_start: pay.depositInStart,
    depositAmount: pay.depositInStart,
    paidNow: pay.paidNow,
    paid_now: pay.paidNow,
    totalAmountPaid: pay.totalPaid,
    total_amount_paid: pay.totalPaid,
    totalPaid: pay.totalPaid,
    amount: pay.totalPaid,
    amountPaid: pay.totalPaid,
    amount_paid: pay.totalPaid,
    remainingAmount,
    remaining_amount: remainingAmount,
    isFullyPaid: remainingAmount <= 0,
    currentInstallment: pay.currentInstallmentLabel,
    current_installment: pay.currentInstallmentLabel,
    installmentNumber: pay.currentInstallmentNumber,
    installment_number: pay.currentInstallmentNumber,
    totalInstallments: pay.totalInstallments,
    verifiedInstallments: pay.verifiedInstallments,
    pendingInstallments: pay.pendingInstallments,
    installments: pay.installments,
    installmentSummary: pay.installmentSummary,

    paymentStatus: booking.paymentStatus || "pending_payment",
    remainingPaymentStatus: booking.remainingPaymentStatus || "unpaid",
    paymentMethod: booking.paymentMethod || "zelle",
    zelleProofUrl: booking.zelleProofUrl || "",
    remainingZelleProofUrl: booking.remainingZelleProofUrl || "",
    zelleVerificationStatus: booking.zelleVerificationStatus || "none",
    remainingZelleVerificationStatus: booking.remainingZelleVerificationStatus || "none",
    zelleTransactionId: booking.zelleTransactionId || "",
    zelleNotes: booking.zelleNotes || "",
    zelleUploadedAt: toIsoOrEmpty(booking.zelleUploadedAt),

    // ── Occasion & preferences
    occasion: booking.occasion || "",
    notes: notes.cleanNotes,
    customerNotes: notes.cleanNotes,
    rawNotes: notes.rawNotes,
    couponCode: booking.couponCode || "",
    discountApplied: Number(booking.discountApplied || 0),
    originalAmount: Number(booking.originalAmount || booking.totalAmount || 0),
    finalAmount: Number(booking.finalAmount || booking.totalAmount || 0),
    promoterName: booking.promoterName || "",

    // ── Private event & venue add-ons
    needDj: Boolean(booking.needDj),
    needPhotographer: Boolean(booking.needPhotographer),
    photographerHours: Number(booking.photographerHours || 0),
    complimentaryDrinks: Number(booking.complimentaryDrinks || 0),
    customCakeDetails: booking.customCakeDetails || null,
    cakeDetails: booking.cakeDetails || "",
    cakePrice: Number(booking.cakePrice || 0),

    // ── Catering, restaurant & dishes
    restaurantName,
    restaurant_name: restaurantName,
    cateringMenu,
    dishes: notes.dishes,
    dishesList: notes.dishesSummary,
    dishes_list: notes.dishesSummary,
    dishesSummary: notes.dishesSummary,
    dishes_summary: notes.dishesSummary,
    dishCount: notes.totalDishCount,
    dish_count: notes.totalDishCount,
    dietaryNotes: notes.dietaryNotes,
    dietary_notes: notes.dietaryNotes,

    // ── Catering quote
    offerPrice: Number(booking.offerPrice || 0),
    foodBasePrice: Number(booking.foodBasePrice || 0),
    foodPaymentStatus: booking.foodPaymentStatus || "unpaid",
    foodPaymentMethod: booking.foodPaymentMethod || "",
    foodZelleProofUrl: booking.foodZelleProofUrl || "",
    dishQuantities: booking.dishQuantities || {},

    timestamp: new Date().toISOString()
  };
};

/** Shared dispatch descriptor for booking lifecycle triggers (includes every employee's contact). */
export const bookingDispatch = async (
  booking: any,
  options: GHLPayloadOptions,
  webhook: GHLWebhookKey = "general"
): Promise<DispatchOptions> => {
  const team = await getEmployeeContacts().catch(() => []);
  return {
    webhook,
    event: options.event,
    ref: `#${shortRef(toId(booking) || String(booking))}`,
    payload: { ...buildBookingPayload(booking, options), ...employeeFields(team) }
  };
};

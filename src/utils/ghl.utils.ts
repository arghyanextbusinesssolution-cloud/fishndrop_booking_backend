import logger from "../config/logger";

// ── Webhook 1: General events (lead, booking confirmed, canceled, rescheduled, media uploaded, zelle pending)
const getWebhookUrl = (): string => {
  return (
    process.env.LEAD_CONNECTOR_WEBHOOK_URL ||
    "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/bc6da1e0-2155-4d01-a223-318afd60c723"
  );
};

// ── Webhook 2: Fired specifically when Zelle deposit is verified → booking confirmed
const ZELLE_CONFIRMED_WEBHOOK_URL =
  process.env.GHL_ZELLE_CONFIRMED_WEBHOOK_URL ||
  "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/bc6da1e0-2155-4d01-a223-318afd60c723";

export type NormalizedStatus =
  | "lead"
  | "pending_payment"
  | "confirmed"
  | "rescheduled"
  | "canceled"
  | "completed";

export interface GHLPayloadOptions {
  event:
    | "lead_created"
    | "booking_confirmed"
    | "booking_canceled"
    | "booking_rescheduled"
    | "guest_media_uploaded"
    | "zelle_payment_submitted"
    | "zelle_payment_confirmed";
  leadStatus: "lead" | "booking" | "canceled" | "rescheduled";
  ghlTag:
    | "Website Lead"
    | "Booking Confirmed"
    | "Booking Canceled"
    | "Booking Rescheduled"
    | "Media Uploaded"
    | "Zelle Payment Pending"
    | "Zelle Payment Confirmed";
  reason?: string;
  paidNow?: number;
  previousBookingDate?: string;
  previousBookingTime?: string;
  mediaDetails?: {
    mediaUrls?: string[];
    photoCount?: number;
    videoCount?: number;
    marketingConsent?: boolean;
  };
}

const getOrdinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * Standardize status across the entire application and webhooks.
 * Prevents spelling discrepancies (e.g. "canceled" vs "cancelled").
 */
export const normalizeBookingStatus = (status?: string): NormalizedStatus => {
  const s = (status || "").toLowerCase().trim();
  if (s === "cancelled" || s === "canceled" || s === "cancel") return "canceled";
  if (s === "rescheduled" || s === "reschedule") return "rescheduled";
  if (s === "confirmed" || s === "confirm") return "confirmed";
  if (s === "pending_payment" || s === "deposit_paid") return "pending_payment";
  if (s === "completed" || s === "complete") return "completed";
  if (s === "lead") return "lead";
  return "lead";
};

/**
 * Accurately converts a local calendar date and time in "America/New_York" (Brooklyn/NYC)
 * into a true UTC Date instance and ISO string.
 *
 * Automatically accounts for Daylight Saving Time transitions (EDT = UTC-4 in summer, EST = UTC-5 in winter).
 * NEVER treats local NYC hours as UTC.
 */
export const getNewYorkUtcDate = (
  year: number,
  month: number, // 1-indexed (1-12)
  day: number,
  hours: number, // 0-23
  minutes: number
): Date => {
  // Construct nominal UTC timestamp with the given local numbers
  const nominalUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));

  // Extract what local time in America/New_York corresponds to nominalUtc
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false
  });

  const parts = dtf.formatToParts(nominalUtc);
  const partMap: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      partMap[part.type] = parseInt(part.value, 10);
    }
  }

  // Handle midnight 24:00 if returned by Intl
  if (partMap.hour === 24) partMap.hour = 0;

  // Local NY time as a UTC representation
  const nyAsUtc = new Date(Date.UTC(
    partMap.year,
    partMap.month - 1,
    partMap.day,
    partMap.hour,
    partMap.minute,
    partMap.second || 0
  ));

  // Offset in milliseconds between UTC and NY at this date/time
  const offsetMs = nominalUtc.getTime() - nyAsUtc.getTime();

  // True UTC date corresponding to the New York local date & time
  return new Date(nominalUtc.getTime() + offsetMs);
};

/**
 * Calculates human-readable 12-hour start and end times, as well as TRUE ISO UTC strings
 * anchored in the venue's timezone ("America/New_York").
 */
export const calculateEventTimes = (
  dateStr: string,
  timeStr: string,
  durationHours: number = 5
) => {
  if (!timeStr) {
    return {
      eventStartTime: "",
      eventEndTime: "",
      eventStartIso: "",
      eventEndIso: "",
      timezone: "America/New_York"
    };
  }

  let hours = 0;
  let minutes = 0;

  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (match) {
    hours = parseInt(match[1], 10);
    minutes = parseInt(match[2], 10);
    const meridian = match[3]?.toUpperCase();
    if (meridian === "PM" && hours < 12) hours += 12;
    if (meridian === "AM" && hours === 12) hours = 0;
  } else {
    const parts = timeStr.split(":").map(Number);
    if (!isNaN(parts[0])) hours = parts[0];
    if (!isNaN(parts[1])) minutes = parts[1];
  }

  // 12-hour format start time (e.g. "7:00 PM")
  const startPeriod = hours >= 12 ? "PM" : "AM";
  const startHours12 = hours % 12 === 0 ? 12 : hours % 12;
  const startMinsFmt = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const eventStartTime = `${startHours12}:${startMinsFmt} ${startPeriod}`;

  // Calculate 12-hour format end time (e.g. "12:00 AM")
  const durationMinutes = Math.round((durationHours || 5) * 60);
  const totalEndMinutes = hours * 60 + minutes + durationMinutes;
  const endHours24 = Math.floor(totalEndMinutes / 60) % 24;
  const endMinutes = totalEndMinutes % 60;
  const endPeriod = endHours24 >= 12 ? "PM" : "AM";
  const endHours12 = endHours24 % 12 === 0 ? 12 : endHours24 % 12;
  const endMinsFmt = endMinutes < 10 ? `0${endMinutes}` : `${endMinutes}`;
  const eventEndTime = `${endHours12}:${endMinsFmt} ${endPeriod}`;

  // ISO Dates anchored strictly in America/New_York
  let eventStartIso = "";
  let eventEndIso = "";
  try {
    if (dateStr) {
      const cleanDate = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
      const [year, month, day] = cleanDate.split("-").map(Number);
      if (year && month && day) {
        const startDtUtc = getNewYorkUtcDate(year, month, day, hours, minutes);
        eventStartIso = startDtUtc.toISOString();

        const endDtUtc = new Date(startDtUtc.getTime() + durationMinutes * 60 * 1000);
        eventEndIso = endDtUtc.toISOString();
      }
    }
  } catch (err) {
    logger.warn("[GHL Utils] Error generating America/New_York ISO dates", err);
  }

  return {
    eventStartTime,
    eventEndTime,
    eventStartIso,
    eventEndIso,
    timezone: "America/New_York"
  };
};

const buildPayload = (booking: any, options: GHLPayloadOptions) => {
  const bookingId = booking._id?.toString?.() || booking.id || String(booking);
  const shortBookingId = bookingId.length >= 6 ? bookingId.slice(-6).toUpperCase() : bookingId;

  const rawDateStr = booking.bookingDate
    ? booking.bookingDate instanceof Date
      ? booking.bookingDate.toISOString().split("T")[0]
      : String(booking.bookingDate).split("T")[0]
    : "";

  const durationHours = Number(booking.durationHours) || (booking.bookingType === "private_event" ? 5 : 2);
  const { eventStartTime, eventEndTime, eventStartIso, eventEndIso, timezone } = calculateEventTimes(
    rawDateStr,
    booking.bookingTime || "",
    durationHours
  );

  let formattedDate = "";
  try {
    if (rawDateStr) {
      const [y, m, d] = rawDateStr.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      formattedDate = dt.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      });
    }
  } catch (e) {
    formattedDate = rawDateStr;
  }

  const name = (booking.customerName || "").trim();
  const nameParts = name.split(" ");
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  // Normalize status: "lead" | "pending_payment" | "confirmed" | "rescheduled" | "canceled" | "completed"
  const normalizedStatus: NormalizedStatus =
    options.event === "booking_canceled"
      ? "canceled"
      : options.event === "booking_rescheduled"
      ? "rescheduled"
      : normalizeBookingStatus(booking.status);

  // Compute total amount paid across all verified paymentBreakdown entries
  const breakdown: any[] = Array.isArray(booking.paymentBreakdown) ? booking.paymentBreakdown : [];
  const verifiedBreakdown = breakdown.filter((p: any) => p.status === "verified");
  const totalPaid =
    verifiedBreakdown.length > 0
      ? verifiedBreakdown.reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0)
      : booking.paymentStatus === "paid"
      ? booking.totalAmount || 0
      : booking.depositAmount || 0;

  const depositEntry = verifiedBreakdown.find((p: any) => p.paymentType === "deposit");
  const depositInStart = depositEntry ? Number(depositEntry.amount || 0) : Number(booking.depositAmount || 0);

  const latestVerified = verifiedBreakdown[verifiedBreakdown.length - 1];
  const paidNow =
    options.paidNow !== undefined
      ? Number(options.paidNow)
      : latestVerified
      ? Number(latestVerified.amount || 0)
      : booking.depositAmount || 0;

  const currentInstallmentNumber = Math.max(1, verifiedBreakdown.length);
  const currentInstallmentLabel = `${getOrdinal(currentInstallmentNumber)} Installment`;

  const installments = verifiedBreakdown.map((item: any, idx: number) => ({
    installment: `${getOrdinal(idx + 1)} Installment`,
    iterationIndex: idx + 1,
    amount: Number(item.amount || 0),
    paymentType: item.paymentType || "deposit",
    paymentMethod: item.paymentMethod || "zelle",
    status: item.status || "verified",
    transactionId: item.transactionId || "",
    paidAt: item.paidAt || item.createdAt || new Date().toISOString()
  }));

  const installmentSummary =
    verifiedBreakdown.length > 0
      ? verifiedBreakdown
          .map(
            (p: any, idx: number) =>
              `${getOrdinal(idx + 1)}: $${Number(p.amount || 0).toFixed(2)} (${
                p.paymentType === "deposit" ? "Deposit" : "Balance"
              })`
          )
          .join(" | ")
      : `Deposit: $${depositInStart.toFixed(2)}`;

  const tableStr = Array.isArray(booking.tables)
    ? booking.tables
        .map((t: any) => (typeof t === "object" ? t.tableNumber || t.name || t._id : String(t)))
        .join(", ")
    : booking.tables
    ? String(booking.tables)
    : "";

  const frontendUrl = process.env.FRONTEND_URL || "https://tropica.nyc";
  const uploadUrl = `${frontendUrl}/upload?bookingId=${bookingId}`;
  const thankYouUrl = uploadUrl;
  const reviewUrl =
    process.env.GOOGLE_REVIEW_URL ||
    "https://api.leadconnectorhq.com/widget/booking/hh2gGpKwljrlKAb3FzN1";

  const mediaUrls = options.mediaDetails?.mediaUrls || (booking.guestMedia ? booking.guestMedia.map((m: any) => m.url) : []);
  const marketingConsent = options.mediaDetails?.marketingConsent ?? Boolean(booking.marketingConsent);

  // Calculate previous event ISO end time if this is a reschedule event
  let previousEventEndIso = "";
  if (options.previousBookingDate && options.previousBookingTime) {
    const prevTimes = calculateEventTimes(options.previousBookingDate, options.previousBookingTime, durationHours);
    previousEventEndIso = prevTimes.eventEndIso;
  }

  // Contact custom fields dictionary (for direct GHL contact custom field mapping)
  const contactCustomFields: Record<string, any> = {
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
    venueName: "Tropica Sanctuary NYC",
    bookingStatus: normalizedStatus,
    booking_status: normalizedStatus,
    uploadUrl,
    upload_url: uploadUrl,
    thankYouUrl,
    thank_you_url: thankYouUrl,
    reviewUrl,
    review_url: reviewUrl,
    marketingConsent: marketingConsent ? "Granted" : "Denied",
    marketing_consent: marketingConsent ? "Granted" : "Denied",
    utmSource: booking.utmSource || "",
    utm_source: booking.utmSource || "",
    utmCampaign: booking.utmCampaign || "",
    utm_campaign: booking.utmCampaign || "",
    utmMedium: booking.utmMedium || "",
    utm_medium: booking.utmMedium || "",
    utmContent: booking.utmContent || "",
    utm_content: booking.utmContent || "",
    utmTerm: booking.utmTerm || "",
    fbclid: booking.fbclid || "",
    isRescheduled: options.event === "booking_rescheduled" || Boolean(booking.rescheduledAt),
    previousBookingDate: options.previousBookingDate || booking.previousBookingDate || "",
    previousBookingTime: options.previousBookingTime || booking.previousBookingTime || "",
    previousEventEndIso,
    previous_event_end_iso: previousEventEndIso
  };

  return {
    // ── Primary Event & Customer Identity ─────────────────────
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
    customerEmail: (booking.customerEmail || "").trim().toLowerCase(),
    email: (booking.customerEmail || "").trim().toLowerCase(),
    customerPhone: (booking.customerPhone || "").trim(),
    phone: (booking.customerPhone || "").trim(),

    // ── Standardized Status (Consistent spelling: "canceled") ─
    status: normalizedStatus,
    bookingStatus: normalizedStatus,
    booking_status: normalizedStatus,
    cancellationReason: options.reason || booking.cancellationReason || "",

    // ── GHL Custom Fields (Available at root AND in customFields)
    bookingId,
    booking_id: bookingId,
    shortBookingId: `#${shortBookingId}`,
    bookingDate: rawDateStr,
    eventDate: rawDateStr,
    event_date: rawDateStr,
    eventDateFormatted: formattedDate,
    event_date_formatted: formattedDate,
    bookingTime: booking.bookingTime || "",
    eventTime: eventStartTime || booking.bookingTime || "",
    eventStartTime: eventStartTime || booking.bookingTime || "",
    event_start_time: eventStartTime || booking.bookingTime || "",
    eventEndTime,
    event_end_time: eventEndTime,

    // ── Timezone-Aware ISO Datetime Strings (America/New_York) ─
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
    venueName: "Tropica Sanctuary NYC",
    tables: tableStr,
    tableNumbers: tableStr,

    // ── Reschedule & Automation Reset Signals ─────────────────
    isRescheduled: options.event === "booking_rescheduled" || Boolean(booking.rescheduledAt),
    previousBookingDate: options.previousBookingDate || booking.previousBookingDate || "",
    previousBookingTime: options.previousBookingTime || booking.previousBookingTime || "",
    previousEventEndIso,
    previous_event_end_iso: previousEventEndIso,
    rescheduledAt: booking.rescheduledAt ? new Date(booking.rescheduledAt).toISOString() : "",
    rescheduleCount: Number(booking.rescheduleCount || (options.event === "booking_rescheduled" ? 1 : 0)),
    workflowAction: options.event === "booking_rescheduled" ? "reset_post_event_workflow" : undefined,
    resetInstructions:
      options.event === "booking_rescheduled"
        ? "Remove contact from old post-event workflow -> update event_end_iso -> re-add contact to workflow"
        : undefined,
    addTags:
      options.event === "booking_rescheduled"
        ? ["Booking Rescheduled", "Rescheduled Reset Needed"]
        : [options.ghlTag],
    removeTags:
      options.event === "booking_rescheduled"
        ? ["Booking Confirmed"]
        : options.event === "booking_canceled"
        ? ["Booking Confirmed", "Booking Rescheduled"]
        : [],

    // ── Post-Event Thank-You & Review Custom Fields ───────────
    uploadUrl,
    upload_url: uploadUrl,
    thankYouUrl,
    thank_you_url: thankYouUrl,
    reviewUrl,
    review_url: reviewUrl,

    // ── Guest Media & Marketing Consent ───────────────────────
    mediaUrls,
    media_urls: mediaUrls,
    photoCount:
      options.mediaDetails?.photoCount ??
      (booking.guestMedia ? booking.guestMedia.filter((m: any) => m.mediaType === "photo").length : 0),
    videoCount:
      options.mediaDetails?.videoCount ??
      (booking.guestMedia ? booking.guestMedia.filter((m: any) => m.mediaType === "video").length : 0),
    marketingConsent,
    marketing_consent: marketingConsent ? "Granted" : "Denied",

    // ── Instagram / Meta Ads & Attribution Custom Fields ──────
    utmSource: booking.utmSource || "",
    utm_source: booking.utmSource || "",
    utmMedium: booking.utmMedium || "",
    utm_medium: booking.utmMedium || "",
    utmCampaign: booking.utmCampaign || "",
    utm_campaign: booking.utmCampaign || "",
    utmContent: booking.utmContent || "",
    utm_content: booking.utmContent || "",
    utmTerm: booking.utmTerm || "",
    fbclid: booking.fbclid || "",
    fbc: booking.fbc || "",
    fbp: booking.fbp || "",
    referralUrl: booking.referralUrl || "",

    // ── Dedicated GHL Custom Fields Dictionary ────────────────
    customFields: contactCustomFields,
    custom_fields: contactCustomFields,

    // ── Financial Breakdown & Installments ────────────────────
    totalAmount: Number(booking.totalAmount || 0),
    total_amount: Number(booking.totalAmount || 0),
    depositInStart,
    deposit_in_start: depositInStart,
    depositAmount: depositInStart,
    paidNow,
    paid_now: paidNow,
    totalAmountPaid: totalPaid,
    total_amount_paid: totalPaid,
    totalPaid,
    amount: totalPaid,
    amountPaid: totalPaid,
    amount_paid: totalPaid,
    remainingAmount: Number(booking.remainingAmount || 0),
    remaining_amount: Number(booking.remainingAmount || 0),
    isFullyPaid: Number(booking.remainingAmount || 0) <= 0,
    currentInstallment: currentInstallmentLabel,
    current_installment: currentInstallmentLabel,
    installmentNumber: currentInstallmentNumber,
    installment_number: currentInstallmentNumber,
    totalInstallments: breakdown.length,
    verifiedInstallments: verifiedBreakdown.length,
    pendingInstallments: breakdown.filter((p: any) => p.status === "pending").length,
    installments,
    installmentSummary,

    paymentStatus: booking.paymentStatus || "pending_payment",
    remainingPaymentStatus: booking.remainingPaymentStatus || "unpaid",
    paymentMethod: booking.paymentMethod || "zelle",
    zelleProofUrl: booking.zelleProofUrl || "",
    remainingZelleProofUrl: booking.remainingZelleProofUrl || "",
    zelleVerificationStatus: booking.zelleVerificationStatus || "none",
    remainingZelleVerificationStatus: booking.remainingZelleVerificationStatus || "none",
    zelleTransactionId: booking.zelleTransactionId || "",
    zelleNotes: booking.zelleNotes || "",
    zelleUploadedAt: booking.zelleUploadedAt ? new Date(booking.zelleUploadedAt).toISOString() : "",

    // ── Occasion and Preferences ──────────────────────────────
    occasion: booking.occasion || "",
    notes: booking.notes || "",
    couponCode: booking.couponCode || "",
    discountApplied: Number(booking.discountApplied || 0),
    originalAmount: Number(booking.originalAmount || booking.totalAmount || 0),
    finalAmount: Number(booking.finalAmount || booking.totalAmount || 0),
    promoterName: booking.promoterName || "",

    // Private event and venue add-ons
    needDj: Boolean(booking.needDj),
    needPhotographer: Boolean(booking.needPhotographer),
    photographerHours: Number(booking.photographerHours || 0),
    cateringMenu: booking.cateringMenu || "none",
    complimentaryDrinks: Number(booking.complimentaryDrinks || 0),
    customCakeDetails: booking.customCakeDetails || null,
    cakeDetails: booking.cakeDetails || "",
    cakePrice: Number(booking.cakePrice || 0),

    // Catering / Restaurant quote details
    offerPrice: Number(booking.offerPrice || 0),
    foodBasePrice: Number(booking.foodBasePrice || 0),
    foodPaymentStatus: booking.foodPaymentStatus || "unpaid",
    foodPaymentMethod: booking.foodPaymentMethod || "",
    foodZelleProofUrl: booking.foodZelleProofUrl || "",
    dishQuantities: booking.dishQuantities || {},

    timestamp: new Date().toISOString()
  };
};

const sendToGHL = async (booking: any, options: GHLPayloadOptions) => {
  const url = getWebhookUrl();
  if (!url) {
    logger.debug("[GHL Webhook] Skipped — LEAD_CONNECTOR_WEBHOOK_URL not configured");
    return;
  }

  try {
    const bookingId = booking._id?.toString?.() || booking.id || String(booking);
    const payload = buildPayload(booking, options);

    logger.info(
      `[GHL Webhook] Sending '${options.event}' (${options.ghlTag}) for booking #${bookingId
        .slice(-6)
        .toUpperCase()} (${booking.customerEmail})`
    );
    console.log(`\n📤 [GHL OUTGOING WEBHOOK] Event: ${options.event} | Tag: ${options.ghlTag}`);
    console.log(
      `📤 [GHL OUTGOING WEBHOOK] America/New_York EventEndIso: ${payload.eventEndIso} | Status: ${payload.status}`
    );

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      logger.warn(`[GHL Webhook] Response HTTP ${response.status}: ${response.statusText}`);
    } else {
      console.log(`✅ [GHL OUTGOING WEBHOOK] Sent successfully — HTTP ${response.status}`);
    }
  } catch (error: any) {
    logger.error("[GHL Webhook] Failed to send GHL payload", { error: error.message });
  }
};

/**
 * Triggered when a guest fills the reservation form (Step 5 / Submit).
 * Sends event: "lead_created" | Tag: "Website Lead"
 */
export const sendGHLLeadEvent = async (booking: any): Promise<void> => {
  await sendToGHL(booking, {
    event: "lead_created",
    leadStatus: "lead",
    ghlTag: "Website Lead"
  });
};

/**
 * Triggered when deposit or full payment is verified.
 * Sends event: "booking_confirmed" | Tag: "Booking Confirmed"
 */
export const sendGHLBookingEvent = async (booking: any, extra?: { paidNow?: number }): Promise<void> => {
  await sendToGHL(booking, {
    event: "booking_confirmed",
    leadStatus: "booking",
    ghlTag: "Booking Confirmed",
    paidNow: extra?.paidNow
  });
};

/**
 * Triggered when a booking is rescheduled.
 * Sends event: "booking_rescheduled" | Tag: "Booking Rescheduled"
 * Transmits explicit workflow reset instructions, America/New_York eventEndIso,
 * and previous date/time to avoid wrong sends in GHL.
 */
export const sendGHLRescheduleEvent = async (
  booking: any,
  previous?: { previousBookingDate?: string; previousBookingTime?: string }
): Promise<void> => {
  await sendToGHL(booking, {
    event: "booking_rescheduled",
    leadStatus: "rescheduled",
    ghlTag: "Booking Rescheduled",
    previousBookingDate: previous?.previousBookingDate,
    previousBookingTime: previous?.previousBookingTime
  });
};

/**
 * Triggered when a booking is canceled.
 * Sends event: "booking_canceled" | Tag: "Booking Canceled"
 */
export const sendGHLCancelEvent = async (booking: any, reason?: string): Promise<void> => {
  await sendToGHL(booking, {
    event: "booking_canceled",
    leadStatus: "canceled",
    ghlTag: "Booking Canceled",
    reason
  });
};

/**
 * Triggered when guest uploads photos/videos from their celebration.
 * Sends event: "guest_media_uploaded" | Tag: "Media Uploaded"
 */
export const sendGHLMediaUploadEvent = async (
  booking: any,
  mediaDetails: {
    mediaUrls?: string[];
    photoCount?: number;
    videoCount?: number;
    marketingConsent?: boolean;
  }
): Promise<void> => {
  await sendToGHL(booking, {
    event: "guest_media_uploaded",
    leadStatus: "booking",
    ghlTag: "Media Uploaded",
    mediaDetails
  });
};

/**
 * Triggered when Zelle payment proof/details are submitted, pending GHL verification.
 * Sends event: "zelle_payment_submitted" | Tag: "Zelle Payment Pending"
 */
export const sendGHLZellePendingEvent = async (booking: any, extra?: { paidNow?: number }): Promise<void> => {
  await sendToGHL(booking, {
    event: "zelle_payment_submitted",
    leadStatus: "lead",
    ghlTag: "Zelle Payment Pending",
    paidNow: extra?.paidNow
  });
};

/**
 * Triggered when Zelle payment (deposit or balance installment) is verified.
 * Sends to the DEDICATED confirmation webhook.
 */
export const sendGHLZelleConfirmedEvent = async (booking: any, extra?: { paidNow?: number }): Promise<void> => {
  try {
    const bookingId = booking._id?.toString?.() || booking.id || String(booking);
    const payload = buildPayload(booking, {
      event: "zelle_payment_confirmed",
      leadStatus: "booking",
      ghlTag: "Zelle Payment Confirmed",
      paidNow: extra?.paidNow
    });

    logger.info(
      `[GHL Zelle Confirmed] Sending confirmation to GHL for booking #${bookingId.slice(-6).toUpperCase()} (${booking.customerEmail})`
    );
    console.log(`\n📤 [GHL ZELLE CONFIRMED OUTGOING WEBHOOK] Event: ${payload.event} | Tag: ${payload.ghlTag}`);

    const response = await fetch(ZELLE_CONFIRMED_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log(`✅ [GHL ZELLE CONFIRMED] Sent successfully — HTTP ${response.status}`);
      logger.info(`[GHL Zelle Confirmed] ✅ Confirmation sent to GHL for booking #${bookingId.slice(-6).toUpperCase()}`);
    } else {
      console.warn(`⚠️ [GHL ZELLE CONFIRMED] GHL responded HTTP ${response.status}: ${response.statusText}`);
      logger.warn(`[GHL Zelle Confirmed] ⚠️ GHL responded HTTP ${response.status}: ${response.statusText}`);
    }
  } catch (error: any) {
    console.error(`❌ [GHL ZELLE CONFIRMED] Failed to send confirmation to GHL:`, error.message);
    logger.error("[GHL Zelle Confirmed] Failed to send confirmation to GHL", { error: error.message });
  }
};

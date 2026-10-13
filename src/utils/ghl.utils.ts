import logger from "../config/logger";

// ── Webhook 1: General events (lead, booking confirmed, canceled, zelle pending)
const getWebhookUrl = (): string => {
  return "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/68dcac67-ddc2-4765-87d7-9034ebe33001";
};

// ── Webhook 2: Fired specifically when Zelle deposit is verified → booking confirmed
const ZELLE_CONFIRMED_WEBHOOK_URL = "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/e5e5e572-b248-4505-8dd0-feb90d2c904d";

export interface GHLPayloadOptions {
  event: "lead_created" | "booking_confirmed" | "booking_canceled" | "zelle_payment_submitted" | "zelle_payment_confirmed";
  leadStatus: "lead" | "booking" | "canceled";
  ghlTag: "Website Lead" | "Booking Confirmed" | "Booking Canceled" | "Zelle Payment Pending" | "Zelle Payment Confirmed";
  reason?: string;
  paidNow?: number;
}

const getOrdinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const buildPayload = (booking: any, options: GHLPayloadOptions) => {
  const bookingId = booking._id?.toString?.() || booking.id || String(booking);
  const shortBookingId = bookingId.length >= 6 ? bookingId.slice(-6).toUpperCase() : bookingId;
  const dateStr = booking.bookingDate
    ? (booking.bookingDate instanceof Date
        ? booking.bookingDate.toISOString().split("T")[0]
        : String(booking.bookingDate).split("T")[0])
    : "";

  // Compute total amount paid across all verified paymentBreakdown entries
  const breakdown: any[] = Array.isArray(booking.paymentBreakdown) ? booking.paymentBreakdown : [];
  const verifiedBreakdown = breakdown.filter((p: any) => p.status === "verified");
  const totalPaid = verifiedBreakdown.length > 0
    ? verifiedBreakdown.reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0)
    : (booking.paymentStatus === "paid" ? (booking.totalAmount || 0) : (booking.depositAmount || 0));

  // Initial deposit in start
  const depositEntry = verifiedBreakdown.find((p: any) => p.paymentType === "deposit");
  const depositInStart = depositEntry ? Number(depositEntry.amount || 0) : Number(booking.depositAmount || 0);

  // Latest verified payment / paid now
  const latestVerified = verifiedBreakdown[verifiedBreakdown.length - 1];
  const paidNow = options.paidNow !== undefined
    ? Number(options.paidNow)
    : (latestVerified ? Number(latestVerified.amount || 0) : (booking.depositAmount || 0));

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

  const installmentSummary = verifiedBreakdown.length > 0
    ? verifiedBreakdown.map((p: any, idx: number) => `${getOrdinal(idx + 1)}: $${Number(p.amount || 0).toFixed(2)} (${p.paymentType === "deposit" ? "Deposit" : "Balance"})`).join(" | ")
    : `Deposit: $${depositInStart.toFixed(2)}`;

  return {
    event: options.event,
    leadStatus: options.leadStatus,
    ghlTag: options.ghlTag,
    cancellationReason: options.reason || "",
    bookingId,
    booking_id: bookingId,
    shortBookingId: `#${shortBookingId}`,
    customerName: booking.customerName || "",
    customerEmail: booking.customerEmail || "",
    customerPhone: booking.customerPhone || "",
    partySize: booking.partySize || 1,
    bookingDate: dateStr,
    bookingTime: booking.bookingTime || "",
    bookingType: booking.bookingType || "standard",
    durationHours: booking.durationHours || 2,
    totalAmount: Number(booking.totalAmount || 0),
    total_amount: Number(booking.totalAmount || 0),

    // ✅ Payment breakdown fields for GHL workflows & reporting
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

    // Installment tracking
    currentInstallment: currentInstallmentLabel,
    current_installment: currentInstallmentLabel,
    installmentNumber: currentInstallmentNumber,
    installment_number: currentInstallmentNumber,
    totalInstallments: breakdown.length,
    verifiedInstallments: verifiedBreakdown.length,
    pendingInstallments: breakdown.filter((p: any) => p.status === "pending").length,
    installments,
    installmentSummary,

    status: booking.status || "pending",
    paymentStatus: booking.paymentStatus || "pending_payment",
    remainingPaymentStatus: booking.remainingPaymentStatus || "unpaid",
    paymentMethod: booking.paymentMethod || "zelle",
    zelleProofUrl: booking.zelleProofUrl || "",
    remainingZelleProofUrl: booking.remainingZelleProofUrl || "",
    zelleVerificationStatus: booking.zelleVerificationStatus || "none",
    remainingZelleVerificationStatus: booking.remainingZelleVerificationStatus || "none",
    zelleTransactionId: booking.zelleTransactionId || "",
    zelleNotes: booking.zelleNotes || "",
    occasion: booking.occasion || "",
    notes: booking.notes || "",
    couponCode: booking.couponCode || "",
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

    logger.info(`[GHL Webhook] Sending '${options.event}' for booking #${bookingId.slice(-6).toUpperCase()} (${booking.customerEmail})`);
    console.log(`\n📤 [GHL OUTGOING WEBHOOK] Event: ${options.event}`);
    console.log(`📤 [GHL OUTGOING WEBHOOK] Payload:\n${JSON.stringify(payload, null, 2)}\n`);

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
 * ✅ Triggered when Zelle payment (deposit or balance installment) is verified.
 * Sends to the DEDICATED confirmation webhook.
 * Fires after handleGHLZelleWebhook verifies the payment.
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

    logger.info(`[GHL Zelle Confirmed] Sending confirmation to GHL for booking #${bookingId.slice(-6).toUpperCase()} (${booking.customerEmail})`);
    console.log(`\n📤 [GHL ZELLE CONFIRMED OUTGOING WEBHOOK] Event: ${payload.event} | Tag: ${payload.ghlTag}`);
    console.log(`📤 [GHL ZELLE CONFIRMED OUTGOING WEBHOOK] Payload:\n${JSON.stringify(payload, null, 2)}\n`);

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



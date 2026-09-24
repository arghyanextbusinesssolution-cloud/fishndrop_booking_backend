import logger from "../config/logger";

const getWebhookUrl = (): string => {
  return "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/68dcac67-ddc2-4765-87d7-9034ebe33001";
};

export interface GHLPayloadOptions {
  event: "lead_created" | "booking_confirmed" | "booking_canceled";
  leadStatus: "lead" | "booking" | "canceled";
  ghlTag: "Website Lead" | "Booking Confirmed" | "Booking Canceled";
  reason?: string;
}

const sendToGHL = async (booking: any, options: GHLPayloadOptions) => {
  const url = getWebhookUrl();
  if (!url) {
    logger.debug("[GHL Webhook] Skipped — LEAD_CONNECTOR_WEBHOOK_URL not configured");
    return;
  }

  try {
    const bookingId = booking._id?.toString?.() || booking.id || String(booking);
    const dateStr = booking.bookingDate
      ? (booking.bookingDate instanceof Date
          ? booking.bookingDate.toISOString().split("T")[0]
          : String(booking.bookingDate).split("T")[0])
      : "";

    const payload = {
      event: options.event,
      leadStatus: options.leadStatus,
      ghlTag: options.ghlTag,
      cancellationReason: options.reason || "",
      bookingId,
      customerName: booking.customerName || "",
      customerEmail: booking.customerEmail || "",
      customerPhone: booking.customerPhone || "",
      partySize: booking.partySize || 1,
      bookingDate: dateStr,
      bookingTime: booking.bookingTime || "",
      bookingType: booking.bookingType || "standard",
      durationHours: booking.durationHours || 2,
      totalAmount: booking.totalAmount || 0,
      depositAmount: booking.depositAmount || 0,
      remainingAmount: booking.remainingAmount || 0,
      status: booking.status || "pending",
      paymentStatus: booking.paymentStatus || "pending_payment",
      occasion: booking.occasion || "",
      notes: booking.notes || "",
      couponCode: booking.couponCode || "",
      timestamp: new Date().toISOString()
    };

    logger.info(`[GHL Webhook] Sending '${options.event}' for booking #${bookingId.slice(-6).toUpperCase()} (${booking.customerEmail})`);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      logger.warn(`[GHL Webhook] Response HTTP ${response.status}: ${response.statusText}`);
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
export const sendGHLBookingEvent = async (booking: any): Promise<void> => {
  await sendToGHL(booking, {
    event: "booking_confirmed",
    leadStatus: "booking",
    ghlTag: "Booking Confirmed"
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

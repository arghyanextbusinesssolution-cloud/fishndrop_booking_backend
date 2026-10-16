const GHL_QUOTE_WEBHOOK_URL =
  "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/a30a35d2-77be-4bf4-94c3-37a3fda40174";

export interface GHLQuotePayload {
  bookingId: string;
  restaurantName: string;
  dishes: Array<{ name: string; quantity: number }>;
  offerPrice: number;
  foodBasePrice: number;
  tropicaFee: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  bookingDate: string;
  negotiationNotes?: string;
  timestamp: string;
}

/**
 * Fires the GHL catering quote webhook when admin dispatches a quote.
 * Payload: restaurant name, all dishes with quantities,
 * offer price breakdown, and booking reference ID for tracking.
 */
export const sendQuoteViaGHL = async (
  payload: GHLQuotePayload
): Promise<{ success: boolean; status?: number; error?: string }> => {
  const webhookUrl = GHL_QUOTE_WEBHOOK_URL;

  console.log(`\n=================== [GHL QUOTE WEBHOOK DISPATCH] ===================`);
  console.log(`[BOOKING ID]      : ${payload.bookingId}`);
  console.log(`[RESTAURANT]      : ${payload.restaurantName}`);
  console.log(`[DISHES]          :`, JSON.stringify(payload.dishes));
  console.log(`[OFFER PRICE]     : $${payload.offerPrice}`);
  console.log(`[CUSTOMER]        : ${payload.customerName} (${payload.customerPhone})`);
  console.log(`[WEBHOOK URL]     : ${webhookUrl}`);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn(`?? [GHL QUOTE WEBHOOK] HTTP ${response.status}: ${response.statusText}`);
      console.log(`=================== [GHL QUOTE WEBHOOK END] ===================\n`);
      return {
        success: false,
        status: response.status,
        error: `GHL webhook responded with HTTP ${response.status}`
      };
    }

    console.log(`? [GHL QUOTE WEBHOOK] Delivered to GoHighLevel (HTTP ${response.status})`);
    console.log(`=================== [GHL QUOTE WEBHOOK END] ===================\n`);
    return { success: true, status: response.status };
  } catch (error: any) {
    console.error(`? [GHL QUOTE WEBHOOK ERROR]:`, error.message);
    console.log(`=================== [GHL QUOTE WEBHOOK END] ===================\n`);
    return {
      success: false,
      error: error.message || "Failed to dispatch quote webhook to GoHighLevel"
    };
  }
};

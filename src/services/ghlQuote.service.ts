const GHL_QUOTE_WEBHOOK_URL =
  process.env.GHL_QUOTE_WEBHOOK_URL ||
  "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/a30a35d2-77be-4bf4-94c3-37a3fda40174";

export interface GHLQuotePayload {
  event?: string;
  ghlTag?: string;
  action?: string;
  leadStatus?: string;
  bookingId: string;
  booking_id?: string;
  shortBookingId?: string;
  customerName: string;
  customer_name?: string;
  first_name?: string;
  last_name?: string;
  customerPhone: string;
  phone?: string;
  customerEmail: string;
  email?: string;
  bookingDate: string;
  booking_date?: string;
  bookingTime?: string;
  booking_time?: string;
  durationHours?: number;
  duration_hours?: number;
  partySize?: number;
  party_size?: number;
  bookingType?: string;
  booking_type?: string;
  occasion?: string;
  venueName?: string;
  tables?: string;
  tableNumbers?: string;
  restaurantName: string;
  restaurant_name?: string;
  cateringMenu?: string;
  dishes: Array<{ name: string; quantity: number }>;
  dishesList?: string;
  dishesSummary?: string;
  dishCount?: number;
  dietaryNotes?: string;
  notes?: string;
  offerPrice: number;
  offer_price?: number;
  quotePrice?: number;
  quote_price?: number;
  formattedOfferPrice?: string;
  foodBasePrice: number;
  food_base_price?: number;
  tropicaFee: number;
  serviceFee?: number;
  totalAmount?: number;
  total_amount?: number;
  depositAmount?: number;
  deposit_amount?: number;
  remainingAmount?: number;
  remaining_amount?: number;
  status?: string;
  paymentStatus?: string;
  offerStatus?: string;
  foodPaymentStatus?: string;
  needDj?: boolean;
  needPhotographer?: boolean;
  photographerHours?: number;
  complimentaryDrinks?: number;
  customCakeDetails?: any;
  cakePrice?: number;
  negotiationNotes?: string;
  quoteNotes?: string;
  timestamp?: string;
  [key: string]: any;
}

/**
 * Fires the GHL catering quote webhook when admin dispatches a quote ("quote_sent").
 * Sends all necessary booking, customer, dishes, and pricing breakdown details to GoHighLevel / LeadConnector.
 */
export const sendQuoteViaGHL = async (
  payload: GHLQuotePayload
): Promise<{ success: boolean; status?: number; error?: string }> => {
  const webhookUrl =
    process.env.GHL_QUOTE_WEBHOOK_URL ||
    GHL_QUOTE_WEBHOOK_URL;

  const nameParts = (payload.customerName || "").trim().split(/\s+/);
  const firstName = payload.first_name || nameParts[0] || "";
  const lastName = payload.last_name || nameParts.slice(1).join(" ") || "";
  const bookingId = payload.bookingId || "";
  const shortId = payload.shortBookingId || (bookingId.length >= 6 ? `#${bookingId.slice(-6).toUpperCase()}` : bookingId);

  const dishesSummary =
    payload.dishesSummary ||
    payload.dishesList ||
    (Array.isArray(payload.dishes) && payload.dishes.length > 0
      ? payload.dishes.map((d) => `${d.name} (x${d.quantity || 1})`).join(", ")
      : "No dishes selected");

  const dishCount =
    payload.dishCount !== undefined
      ? payload.dishCount
      : (Array.isArray(payload.dishes)
          ? payload.dishes.reduce((sum, d) => sum + (Number(d.quantity) || 1), 0)
          : 0);

  const fullPayload: Record<string, any> = {
    ...payload,
    event: payload.event || "quote_sent",
    ghlTag: payload.ghlTag || "Quote Sent",
    action: payload.action || "quote_sent",
    leadStatus: payload.leadStatus || "booking",
    bookingId,
    booking_id: bookingId,
    shortBookingId: shortId,
    customerName: payload.customerName || "",
    customer_name: payload.customerName || "",
    first_name: firstName,
    last_name: lastName,
    customerEmail: payload.customerEmail || "",
    email: payload.customerEmail || "",
    customerPhone: payload.customerPhone || "",
    phone: payload.customerPhone || "",
    bookingDate: payload.bookingDate || "",
    booking_date: payload.bookingDate || "",
    bookingTime: payload.bookingTime || "",
    booking_time: payload.bookingTime || "",
    durationHours: payload.durationHours || 5,
    duration_hours: payload.durationHours || 5,
    partySize: payload.partySize || 1,
    party_size: payload.partySize || 1,
    bookingType: payload.bookingType || "private_event",
    booking_type: payload.bookingType || "private_event",
    occasion: payload.occasion || "",
    venueName: payload.venueName || "Tropica / Fish & Drop",
    tables: payload.tables || "",
    tableNumbers: payload.tableNumbers || payload.tables || "",
    restaurantName: payload.restaurantName || "",
    restaurant_name: payload.restaurant_name || payload.restaurantName || "",
    cateringMenu: payload.cateringMenu || "",
    dishes: payload.dishes || [],
    dishesList: dishesSummary,
    dishesSummary,
    dishCount,
    dietaryNotes: payload.dietaryNotes || "",
    notes: payload.notes || "",
    negotiationNotes: payload.negotiationNotes || "",
    quoteNotes: payload.quoteNotes || payload.negotiationNotes || "",
    offerPrice: Number(payload.offerPrice || 0),
    offer_price: Number(payload.offerPrice || 0),
    quotePrice: Number(payload.offerPrice || 0),
    quote_price: Number(payload.offerPrice || 0),
    formattedOfferPrice: `$${Number(payload.offerPrice || 0).toFixed(2)}`,
    foodBasePrice: Number(payload.foodBasePrice || 0),
    food_base_price: Number(payload.foodBasePrice || 0),
    tropicaFee: Number(payload.tropicaFee || 50),
    serviceFee: Number(payload.tropicaFee || 50),
    totalAmount: Number(payload.totalAmount || 0),
    total_amount: Number(payload.totalAmount || 0),
    depositAmount: Number(payload.depositAmount || 0),
    deposit_amount: Number(payload.depositAmount || 0),
    remainingAmount: Number(payload.remainingAmount || 0),
    remaining_amount: Number(payload.remainingAmount || 0),
    status: payload.status || "confirmed",
    paymentStatus: payload.paymentStatus || "pending_payment",
    offerStatus: payload.offerStatus || "offered",
    foodPaymentStatus: payload.foodPaymentStatus || "unpaid",
    needDj: Boolean(payload.needDj),
    needPhotographer: Boolean(payload.needPhotographer),
    photographerHours: Number(payload.photographerHours || 0),
    complimentaryDrinks: Number(payload.complimentaryDrinks || 0),
    customCakeDetails: payload.customCakeDetails || null,
    cakePrice: Number(payload.cakePrice || 0),
    timestamp: payload.timestamp || new Date().toISOString()
  };

  console.log(`\n=================== [GHL QUOTE WEBHOOK DISPATCH] ===================`);
  console.log(`[BOOKING ID]      : ${fullPayload.bookingId} (${fullPayload.shortBookingId})`);
  console.log(`[EVENT / TAG]     : ${fullPayload.event} / ${fullPayload.ghlTag}`);
  console.log(`[RESTAURANT]      : ${fullPayload.restaurantName}`);
  console.log(`[DISHES]          : ${fullPayload.dishesSummary}`);
  console.log(`[OFFER PRICE]     : $${fullPayload.offerPrice} (Base: $${fullPayload.foodBasePrice} + Tropica Fee: $${fullPayload.tropicaFee})`);
  console.log(`[CUSTOMER]        : ${fullPayload.customerName} (${fullPayload.customerPhone} / ${fullPayload.customerEmail})`);
  console.log(`[WEBHOOK URL]     : ${webhookUrl}`);
  console.log(`[FULL PAYLOAD]    :\n${JSON.stringify(fullPayload, null, 2)}`);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fullPayload)
    });

    if (!response.ok) {
      console.warn(`⚠️ [GHL QUOTE WEBHOOK] HTTP ${response.status}: ${response.statusText}`);
      console.log(`=================== [GHL QUOTE WEBHOOK END] ===================\n`);
      return {
        success: false,
        status: response.status,
        error: `GHL webhook responded with HTTP ${response.status}`
      };
    }

    console.log(`✅ [GHL QUOTE WEBHOOK] Delivered to GoHighLevel (HTTP ${response.status})`);
    console.log(`=================== [GHL QUOTE WEBHOOK END] ===================\n`);
    return { success: true, status: response.status };
  } catch (error: any) {
    console.error(`❌ [GHL QUOTE WEBHOOK ERROR]:`, error.message);
    console.log(`=================== [GHL QUOTE WEBHOOK END] ===================\n`);
    return {
      success: false,
      error: error.message || "Failed to dispatch quote webhook to GoHighLevel"
    };
  }
};

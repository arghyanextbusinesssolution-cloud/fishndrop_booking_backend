const DEFAULT_GHL_OTP_WEBHOOK =
  "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger/cd3af5f8-28a9-4cea-a279-086c3468702c";

export interface GHLOtpRequest {
  phone: string;
  otp: string;
}

/**
 * Converts a phone number to standard international E.164 format (+1XXXXXXXXXX)
 */
export const formatToE164 = (phone: string): string => {
  const clean = phone.replace(/[^\d+]/g, "");
  const digits = clean.replace(/\D/g, "");

  // If standard 10 digits (US/Canada), format as +1XXXXXXXXXX
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // If 11 digits starting with 1, format as +1XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (!clean.startsWith("+")) {
    return `+${clean}`;
  }

  return clean;
};

/**
 * Dispatches strictly the recipient phone number, 4-digit OTP code, and message timestamp
 * to the GoHighLevel webhook.
 */
export const sendOtpViaGHL = async (
  data: GHLOtpRequest
): Promise<{ success: boolean; status?: number; error?: string }> => {
  const webhookUrl = process.env.GHL_OTP_WEBHOOK_URL || DEFAULT_GHL_OTP_WEBHOOK;
  const formattedPhone = formatToE164(data.phone);
  const messageTimestamp = new Date().toISOString();

  // Clean payload: strictly mobile number, 4-digit OTP, and message timestamp
  const payload = {
    number: formattedPhone,
    phone: formattedPhone,
    otp: data.otp,
    timestamp: messageTimestamp
  };

  console.log(`\n=================== [GHL OTP WEBHOOK DISPATCH] ===================`);
  console.log(`[TARGET PHONE] : ${formattedPhone}`);
  console.log(`[OTP CODE]     : ${data.otp}`);
  console.log(`[TIMESTAMP]    : ${messageTimestamp}`);
  console.log(`[WEBHOOK URL]  : ${webhookUrl}`);
  console.log(`[PAYLOAD]      :`, JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn(`⚠️ [GHL OTP WEBHOOK] Response HTTP ${response.status}: ${response.statusText}`);
      console.log(`=================== [GHL OTP WEBHOOK END] ===================\n`);
      return {
        success: false,
        status: response.status,
        error: `GHL webhook responded with HTTP ${response.status}`
      };
    }

    console.log(`✅ [GHL OTP WEBHOOK] Successfully delivered to GoHighLevel (HTTP ${response.status})`);
    console.log(`=================== [GHL OTP WEBHOOK END] ===================\n`);

    return {
      success: true,
      status: response.status
    };
  } catch (error: any) {
    console.error(`❌ [GHL OTP WEBHOOK ERROR]:`, error.message);
    console.log(`=================== [GHL OTP WEBHOOK END] ===================\n`);
    return {
      success: false,
      error: error.message || "Failed to dispatch OTP webhook to GoHighLevel"
    };
  }
};

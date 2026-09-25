import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

const getTwilioClient = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID || accountSid;
  const token = process.env.TWILIO_AUTH_TOKEN || authToken;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID || verifyServiceSid;

  if (!sid || !token || !serviceSid) {
    throw new Error("Missing Twilio credentials or TWILIO_VERIFY_SERVICE_SID in environment");
  }

  return {
    client: twilio(sid, token),
    serviceSid
  };
};

/**
 * Converts a phone number to standard international E.164 format (+1XXXXXXXXXX)
 */
export const formatToE164 = (phone: string): string => {
  let clean = phone.replace(/[^\d+]/g, "");

  if (!clean.startsWith("+")) {
    // If standard 10 digits (US/Canada), prepend +1
    if (clean.length === 10) {
      clean = `+1${clean}`;
    } else {
      clean = `+${clean}`;
    }
  }

  return clean;
};

/**
 * 1. Requests Twilio Verify to generate and deliver a 6-digit OTP code via SMS
 */
export const sendVerificationCode = async (
  rawPhone: string
): Promise<{ success: boolean; status?: string; error?: string }> => {
  try {
    const to = formatToE164(rawPhone);
    const { client, serviceSid } = getTwilioClient();

    console.log(`\n=================== [TWILIO VERIFY START] ===================`);
    console.log(`[TARGET PHONE] : ${to}`);
    console.log(`[SERVICE SID]  : ${serviceSid}`);

    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications.create({
        to,
        channel: "sms"
      });

    console.log(`✅ [Twilio Verify Sent] Status: ${verification.status}`);
    console.log(`=================== [TWILIO VERIFY END] ===================\n`);

    return {
      success: true,
      status: verification.status
    };
  } catch (error: any) {
    console.error("❌ [Twilio Verify Send Error]:", error.message);
    console.log(`=================== [TWILIO VERIFY END] ===================\n`);
    return {
      success: false,
      error: error.message || "Failed to send verification SMS via Twilio"
    };
  }
};

/**
 * 2. Checks and validates the code entered by the user directly with Twilio
 */
export const checkVerificationCode = async (
  rawPhone: string,
  code: string
): Promise<{ success: boolean; approved: boolean; error?: string }> => {
  try {
    const to = formatToE164(rawPhone);
    const { client, serviceSid } = getTwilioClient();

    console.log(`\n=================== [TWILIO VERIFY CHECK START] ===================`);
    console.log(`[TARGET PHONE] : ${to}`);
    console.log(`[ENTERED CODE] : ${code}`);

    const check = await client.verify.v2
      .services(serviceSid)
      .verificationChecks.create({
        to,
        code: code.trim()
      });

    console.log(`[TWILIO CHECK STATUS]: ${check.status}`);
    console.log(`=================== [TWILIO VERIFY CHECK END] ===================\n`);

    const approved = check.status === "approved";
    return {
      success: true,
      approved,
      error: approved ? undefined : "Incorrect or expired verification code"
    };
  } catch (error: any) {
    console.error("❌ [Twilio Verify Check Error]:", error.message);
    console.log(`=================== [TWILIO VERIFY CHECK END] ===================\n`);
    return {
      success: false,
      approved: false,
      error: error.message || "Failed to verify code with Twilio"
    };
  }
};

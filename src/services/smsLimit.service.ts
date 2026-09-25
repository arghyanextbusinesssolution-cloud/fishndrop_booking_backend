import SmsUsage from "../models/SmsUsage";

export const getTodayKey = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const getDailyLimit = (): number => {
  const envVal = Number(process.env.DAILY_SMS_LIMIT);
  return !Number.isNaN(envVal) && envVal > 0 ? envVal : 50;
};

/**
 * Checks if the SMS quota allows a new verification SMS to be sent.
 * 1. Checks per-phone rate limiting (max 3 SMS per phone per 15 minutes).
 * 2. Checks global daily SMS cap (default 50 SMS/day).
 */
export const checkSmsQuota = async (
  rawPhone: string
): Promise<{ allowed: boolean; error?: string; remaining?: number; currentCount?: number }> => {
  const limit = getDailyLimit();
  const todayKey = getTodayKey();
  const cleanPhone = rawPhone.replace(/[^\d+]/g, "");

  const usage = await SmsUsage.findOne({ date: todayKey });
  const currentCount = usage?.count || 0;

  // 1. Global Daily Cap check
  if (currentCount >= limit) {
    console.warn(`[SMS Quota Reached] Today's limit of ${limit} SMS reached (${currentCount}/${limit}).`);
    return {
      allowed: false,
      currentCount,
      remaining: 0,
      error: `Daily SMS verification limit of ${limit} reached. Please try again tomorrow or contact the restaurant.`
    };
  }

  // 2. Per-phone throttling check (Max 3 attempts per 15 minutes)
  if (usage?.phoneLogs && usage.phoneLogs.length > 0) {
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const recentAttempts = usage.phoneLogs.filter(
      (log) => log.phone === cleanPhone && new Date(log.timestamp) >= fifteenMinsAgo
    );

    if (recentAttempts.length >= 3) {
      console.warn(`[SMS Rate Limit] Phone ${cleanPhone} exceeded 3 requests in 15 minutes.`);
      return {
        allowed: false,
        currentCount,
        remaining: Math.max(0, limit - currentCount),
        error: "Too many verification requests for this number. Please wait 15 minutes before trying again."
      };
    }
  }

  return {
    allowed: true,
    currentCount,
    remaining: Math.max(0, limit - currentCount)
  };
};

/**
 * Atomically records an SMS dispatch in MongoDB and increments the daily counter.
 */
export const recordSmsDispatch = async (
  rawPhone: string,
  status: string = "sent"
): Promise<{ count: number; limit: number; remaining: number }> => {
  const limit = getDailyLimit();
  const todayKey = getTodayKey();
  const cleanPhone = rawPhone.replace(/[^\d+]/g, "");

  const updated = await SmsUsage.findOneAndUpdate(
    { date: todayKey },
    {
      $inc: { count: 1 },
      $push: {
        phoneLogs: {
          phone: cleanPhone,
          timestamp: new Date(),
          status
        }
      }
    },
    { upsert: true, returnDocument: "after" }
  );

  const count = updated?.count || 1;
  const remaining = Math.max(0, limit - count);

  console.log(`📊 [SMS Quota] Sent: ${count}/${limit} today (Remaining: ${remaining})`);

  return {
    count,
    limit,
    remaining
  };
};

/**
 * Retrieves the current day's SMS quota usage.
 */
export const getSmsQuotaStatus = async () => {
  const limit = getDailyLimit();
  const todayKey = getTodayKey();
  const usage = await SmsUsage.findOne({ date: todayKey });
  const count = usage?.count || 0;

  return {
    date: todayKey,
    sent: count,
    limit,
    remaining: Math.max(0, limit - count)
  };
};

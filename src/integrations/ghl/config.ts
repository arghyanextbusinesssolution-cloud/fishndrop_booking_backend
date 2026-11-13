/**
 * GHL (LeadConnector) integration configuration.
 *
 * Every inbound-webhook URL is resolved from the environment first, falling back to the
 * historical production URL so existing deployments keep working without new env vars.
 * URLs are resolved lazily (on each call) so env changes made after module load
 * (dotenv, tests) are respected.
 */

const HOOK_BASE = "https://services.leadconnectorhq.com/hooks/3HmJCw40C6xzJYaLg6cK/webhook-trigger";

export type GHLWebhookKey =
  | "general"
  | "zelleConfirmed"
  | "promoterApplication"
  | "promoterVerification"
  | "employeeAccount"
  | "promoterEventCreated"
  | "eventApproved"
  | "ticketPurchased"
  | "bookingSync";

interface WebhookDefinition {
  envVars: string[];
  fallback: string;
}

const WEBHOOKS: Record<GHLWebhookKey, WebhookDefinition> = {
  // Lead, booking confirmed/canceled/rescheduled, media, zelle pending, tickets, guest passes, event approved
  general: {
    envVars: ["LEAD_CONNECTOR_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/bc6da1e0-2155-4d01-a223-318afd60c723`
  },
  // Zelle deposit / installment verified
  zelleConfirmed: {
    envVars: ["GHL_ZELLE_CONFIRMED_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/bc6da1e0-2155-4d01-a223-318afd60c723`
  },
  // Promoter application submitted
  promoterApplication: {
    envVars: ["GHL_PROMOTER_APPLICATION_NOTIFICATION_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/dceec608-6d07-4631-9215-37fd87a94671`
  },
  // Promoter verified / rejected
  promoterVerification: {
    envVars: ["GHL_PROMOTER_VERIFICATION_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/535675d6-cefa-4fd2-93ae-d409eda9d8b5`
  },
  // Employee (staff) account created by admin → welcome notification with login email, password & link
  employeeAccount: {
    envVars: ["GHL_EMPLOYEE_ACCOUNT_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/f4b3c12f-a2ee-4ab8-861d-ccf0e95bda1e`
  },
  // Promoter created a new event (full event + ticket tiers + promoter data)
  promoterEventCreated: {
    envVars: ["GHL_PROMOTER_EVENT_CREATED_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/98280bf0-96c4-4193-8b94-ae2db6a4487d`
  },
  // Employee/admin approved a promoter event → "your event is live" message to the promoter
  eventApproved: {
    envVars: ["GHL_EVENT_APPROVED_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/f8517f89-d983-4bae-842f-05c0ccebe461`
  },
  // Event ticket purchase → customer confirmation + promoter & admin sale alerts
  ticketPurchased: {
    envVars: ["GHL_TICKET_PURCHASED_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/d6176daa-d234-4e50-adaf-5287d8d77eba`
  },
  // Full booking snapshot on every change + venue availability (feeds GHL Conversation AI for IG/TikTok chats)
  bookingSync: {
    envVars: ["GHL_BOOKING_SYNC_WEBHOOK_URL"],
    fallback: `${HOOK_BASE}/d26300bb-d62f-4d63-a92e-306b1855e4a6`
  }
};

export const getWebhookUrl = (key: GHLWebhookKey): string => {
  const def = WEBHOOKS[key];
  for (const name of def.envVars) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return def.fallback;
};

const toInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const getClientConfig = () => ({
  /** Set GHL_WEBHOOKS_ENABLED=false to disable all outbound GHL calls (e.g. local dev, tests). */
  enabled: (process.env.GHL_WEBHOOKS_ENABLED ?? "true").toLowerCase() !== "false",
  timeoutMs: toInt(process.env.GHL_WEBHOOK_TIMEOUT_MS, 10_000, 1_000, 60_000),
  maxAttempts: toInt(process.env.GHL_WEBHOOK_MAX_ATTEMPTS, 3, 1, 6),
  baseBackoffMs: toInt(process.env.GHL_WEBHOOK_BACKOFF_MS, 500, 50, 10_000),
  /** Full payloads contain PII — only log them when explicitly requested. */
  logPayloads: (process.env.GHL_LOG_PAYLOADS ?? "").toLowerCase() === "true"
});

export const VENUE_NAME = "Tropica Sanctuary NYC";
export const VENUE_TIMEZONE = "America/New_York";

/** Used by booking payloads (historically read FRONTEND_URL). */
export const getBookingFrontendUrl = (): string => process.env.FRONTEND_URL || "https://tropica.nyc";

/** Used by event / ticket / employee payloads (historically read FRONTEND_BASE_URL). */
export const getPublicSiteUrl = (): string => process.env.FRONTEND_BASE_URL || "https://www.tropica.nyc";

export const getReviewUrl = (): string =>
  process.env.GOOGLE_REVIEW_URL || "https://api.leadconnectorhq.com/widget/booking/hh2gGpKwljrlKAb3FzN1";

/**
 * Website base for links inside GHL messages (emails/SMS to people).
 * Uses FRONTEND_BASE_URL, but never a localhost address.
 */
export const getPublicLinkBase = (): string => {
  const site = getPublicSiteUrl().replace(/\/+$/, "");
  return /localhost|127\.0\.0\.1/i.test(site) ? "https://www.tropica.nyc" : site;
};

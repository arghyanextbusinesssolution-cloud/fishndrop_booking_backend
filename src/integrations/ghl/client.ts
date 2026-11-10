import logger from "../../config/logger";
import { getClientConfig, getWebhookUrl, GHLWebhookKey } from "./config";

export interface DispatchResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  attempts: number;
  durationMs: number;
  error?: string;
}

export interface DispatchOptions {
  /** Which configured webhook to post to. */
  webhook: GHLWebhookKey;
  /** Event name, used for logging. */
  event: string;
  /** Short entity reference for logs (e.g. "#A1B2C3"). Never put PII here. */
  ref?: string;
  payload: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry on network errors, timeouts, 408, 429 and 5xx. Other 4xx are permanent. */
const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** Log the hook id only — the full URL is a credential. */
const maskUrl = (url: string): string => {
  const tail = url.split("/").filter(Boolean).pop() || "";
  return tail.length > 8 ? `…/${tail.slice(0, 8)}` : "…";
};

/**
 * POSTs a JSON payload to a GHL inbound webhook with timeout + exponential-backoff retries.
 *
 * Never throws: triggers are fire-and-forget from request handlers, so a GHL outage must
 * never fail a booking/payment flow. The result is returned for callers that care.
 */
export const dispatchToGHL = async ({ webhook, event, ref, payload }: DispatchOptions): Promise<DispatchResult> => {
  const config = getClientConfig();
  const startedAt = Date.now();
  const ctx = { event, ref, webhook };

  if (!config.enabled) {
    logger.debug("[GHL] Skipped — GHL_WEBHOOKS_ENABLED=false", ctx);
    return { ok: false, skipped: true, attempts: 0, durationMs: 0 };
  }

  const url = getWebhookUrl(webhook);
  if (!url) {
    logger.warn("[GHL] Skipped — webhook URL not configured", ctx);
    return { ok: false, skipped: true, attempts: 0, durationMs: 0 };
  }

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (err: any) {
    logger.error("[GHL] Payload serialization failed", { ...ctx, error: err?.message });
    return { ok: false, attempts: 0, durationMs: Date.now() - startedAt, error: err?.message };
  }

  if (config.logPayloads) {
    const redacted = JSON.parse(body, (k, v) => (/password/i.test(k) && v ? "[redacted]" : v));
    logger.debug(`[GHL] Payload for '${event}'`, { ...ctx, payload: redacted });
  }

  let lastError = "";
  let lastStatus: number | undefined;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    attemptsMade = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      lastStatus = res.status;

      if (res.ok) {
        // Drain body so the socket can be reused.
        await res.text().catch(() => "");
        const durationMs = Date.now() - startedAt;
        logger.info(`[GHL] Sent '${event}'`, { ...ctx, status: res.status, attempt, durationMs });
        return { ok: true, status: res.status, attempts: attempt, durationMs };
      }

      const responseText = (await res.text().catch(() => "")).slice(0, 500);
      lastError = `HTTP ${res.status} ${res.statusText}${responseText ? ` — ${responseText}` : ""}`;

      if (!isRetryableStatus(res.status)) break;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err?.name === "AbortError" ? `Timed out after ${config.timeoutMs}ms` : err?.message || String(err);
    }

    if (attempt < config.maxAttempts) {
      const backoff = config.baseBackoffMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * config.baseBackoffMs);
      logger.warn(`[GHL] '${event}' attempt ${attempt} failed, retrying`, {
        ...ctx,
        error: lastError,
        retryInMs: backoff + jitter
      });
      await sleep(backoff + jitter);
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.error(`[GHL] Failed to send '${event}'`, {
    ...ctx,
    hook: maskUrl(url),
    status: lastStatus,
    attempts: attemptsMade,
    error: lastError,
    durationMs
  });
  return { ok: false, status: lastStatus, attempts: attemptsMade, durationMs, error: lastError };
};

/**
 * Wraps a trigger so that payload-building bugs are logged instead of becoming
 * unhandled promise rejections (callers use `void sendX(...)`).
 */
export const safeTrigger = async (
  event: string,
  build: () => DispatchOptions | null | Promise<DispatchOptions | null>
): Promise<DispatchResult | undefined> => {
  try {
    const options = await build();
    if (!options) return undefined;
    return await dispatchToGHL(options);
  } catch (err: any) {
    logger.error(`[GHL] Failed to build '${event}' payload`, { event, error: err?.message, stack: err?.stack });
    return undefined;
  }
};

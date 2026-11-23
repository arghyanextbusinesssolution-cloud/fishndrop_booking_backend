import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import logger from "../config/logger";
import { AuditStore, auditStorage, currentActor } from "./context";
import { sanitizeForAudit } from "./sanitize";

/**
 * Opens the audit context for every API request and, when it finishes, records the action itself
 * (who · when · endpoint · what they submitted · result) for staff and webhook create/change/delete calls.
 */

// Automated callers that change data without a logged-in user
const SYSTEM_CALLERS: Array<[RegExp, string]> = [
  [/^\/api\/payments\/(ghl-zelle-webhook|zelle-webhook|zelle\/webhook)/, "Zelle webhook (GHL bank alert)"],
  [/^\/api\/payments\/webhook/, "Stripe webhook"],
  [/^\/api\/webhooks\//, "GHL webhook"]
];

// Too noisy / not staff actions
const SKIP_PATHS = [/^\/api\/ai\/(ghl\/messages|test-chat)/, /^\/api\/auth\/(login|send-otp|verify-otp|refresh)/];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const auditMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const path = (req.originalUrl || req.url || "").split("?")[0];
  const system = SYSTEM_CALLERS.find(([re]) => re.test(path));
  const store: AuditStore = {
    requestId: crypto.randomUUID(),
    method: req.method,
    path,
    ip: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    req: req as unknown as AuditStore["req"],
    system: system ? { name: system[1], role: "system" } : undefined
  };

  if (MUTATING.has(req.method) && !SKIP_PATHS.some((re) => re.test(path))) {
    const started = Date.now();
    // Capture the JSON message the endpoint answers with (e.g. "Booking not found")
    let responseMessage = "";
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const msg = (body as { message?: unknown })?.message;
      if (typeof msg === "string") responseMessage = msg.slice(0, 500);
      return originalJson(body);
    }) as typeof res.json;

    res.on("finish", () => {
      const actor = currentActor(store);
      if (!actor) return; // customers / anonymous visitors aren't audited
      const AuditLog = mongoose.models.AuditLog;
      if (!AuditLog) return;
      const route = (req as Request & { route?: { path?: string } }).route?.path;
      void AuditLog.create({
        kind: "request",
        requestId: store.requestId,
        at: new Date(started),
        actor,
        method: req.method,
        path,
        route: route ? `${req.baseUrl || ""}${route}` : path,
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
        ip: store.ip,
        userAgent: store.userAgent,
        requestBody: sanitizeForAudit(req.body),
        params: sanitizeForAudit(req.params),
        query: sanitizeForAudit(req.query),
        responseMessage
      }).catch((err: Error) => logger.warn("[AUDIT] request log failed", { error: err.message }));
    });
  }

  auditStorage.run(store, () => next());
};

export default auditMiddleware;

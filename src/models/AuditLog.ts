import { Schema, model } from "mongoose";

/**
 * Audit trail for the admin panel.
 *   kind "request" → one staff/webhook action (who, when, which endpoint, what they submitted, result)
 *   kind "change"  → what that action did to one record (create / update / delete + field-by-field before/after)
 * Both share requestId. Kept AUDIT_RETENTION_DAYS (default 365) days.
 */
const RETENTION_DAYS = Math.max(30, Number(process.env.AUDIT_RETENTION_DAYS) || 365);

const auditLogSchema = new Schema(
  {
    kind: { type: String, enum: ["request", "change"], required: true, index: true },
    requestId: { type: String, required: true, index: true },
    at: { type: Date, default: Date.now, index: { expireAfterSeconds: RETENTION_DAYS * 24 * 3600 } },
    actor: {
      id: String,
      name: String,
      email: String,
      role: String
    },
    // request
    method: String,
    path: String,
    route: String,
    statusCode: Number,
    durationMs: Number,
    ip: String,
    userAgent: String,
    requestBody: Schema.Types.Mixed,
    params: Schema.Types.Mixed,
    query: Schema.Types.Mixed,
    responseMessage: String,
    // change
    action: { type: String, enum: ["create", "update", "delete"] },
    entity: { type: String, index: true },
    entityId: { type: String, index: true },
    entityLabel: String,
    changes: [{ _id: false, field: String, before: Schema.Types.Mixed, after: Schema.Types.Mixed }],
    snapshot: Schema.Types.Mixed // full record for create (after) / delete (before)
  },
  { versionKey: false, minimize: false }
);

auditLogSchema.index({ kind: 1, at: -1 });
auditLogSchema.index({ "actor.email": 1, at: -1 });

export default model("AuditLog", auditLogSchema);

import mongoose, { Schema } from "mongoose";
import logger from "../config/logger";
import { currentActor, currentAudit, isAuditing } from "./context";
import { diffSnapshots, recordLabel, sanitizeForAudit } from "./sanitize";

/**
 * Global Mongoose plugin: while a staff member (or a webhook) is creating / changing / deleting something,
 * every affected record is written to the audit log with a field-by-field before → after.
 * Does nothing for page views (GET), customers' own actions, cron jobs or the excluded noisy models.
 */
const EXCLUDED_MODELS = new Set(["AuditLog", "AiConversation", "AiBookingDraft", "OtpCode", "SmsUsage"]);
const MAX_DOCS_PER_QUERY = 50;

type Plain = Record<string, unknown>;

const writeChange = (entry: {
  action: "create" | "update" | "delete";
  entity: string;
  doc: Plain;
  changes?: { field: string; before: unknown; after: unknown }[];
  snapshot?: Plain;
}) => {
  const store = currentAudit();
  const actor = currentActor(store);
  if (!store || !actor) return;
  // Lazy: the AuditLog model is compiled after this plugin is registered
  const AuditLog = mongoose.models.AuditLog;
  if (!AuditLog) return;
  void AuditLog.create({
    kind: "change",
    requestId: store.requestId,
    at: new Date(),
    actor,
    method: store.method,
    path: store.path,
    action: entry.action,
    entity: entry.entity,
    entityId: String(entry.doc?._id ?? ""),
    entityLabel: recordLabel(entry.doc).slice(0, 160),
    changes: entry.changes || [],
    snapshot: entry.snapshot ? sanitizeForAudit(entry.snapshot) : undefined
  }).catch((err: Error) => logger.warn("[AUDIT] change log failed", { error: err.message }));
};

/** Model name for a top-level document; null for nested items (subdocuments) or excluded models. */
const modelOf = (doc: mongoose.Document): string | null => {
  if ((doc as unknown as { $isSubdocument?: boolean }).$isSubdocument) return null;
  const name = (doc.constructor as mongoose.Model<unknown>)?.modelName;
  return name && !EXCLUDED_MODELS.has(name) ? name : null;
};

const plain = (doc: mongoose.Document): Plain => doc.toObject({ depopulate: true, virtuals: false }) as Plain;

export const auditPlugin = (schema: Schema) => {
  // ---- documents: load → save / delete
  schema.post("init", function (this: mongoose.Document) {
    const name = modelOf(this);
    if (!name || !isAuditing()) return;
    this.$locals.auditBefore = plain(this);
  });

  schema.pre("save", function (this: mongoose.Document) {
    if (!modelOf(this)) return;
    this.$locals.auditWasNew = this.isNew;
  });

  schema.post("save", function (this: mongoose.Document) {
    const name = modelOf(this);
    if (!name || !isAuditing()) return;
    const after = plain(this);
    if (this.$locals.auditWasNew) {
      writeChange({ action: "create", entity: name, doc: after, snapshot: after });
    } else {
      const changes = diffSnapshots((this.$locals.auditBefore as Plain) || {}, after);
      if (changes.length) writeChange({ action: "update", entity: name, doc: after, changes });
    }
    this.$locals.auditBefore = after;
  });

  schema.post("deleteOne", { document: true, query: false }, function (this: mongoose.Document) {
    const name = modelOf(this);
    if (!name || !isAuditing()) return;
    const before = plain(this);
    writeChange({ action: "delete", entity: name, doc: before, snapshot: before });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema.post("insertMany", function (this: mongoose.Model<unknown>, docs: any) {
    const name = this.modelName;
    if (EXCLUDED_MODELS.has(name) || !isAuditing() || !Array.isArray(docs)) return;
    for (const d of docs as mongoose.Document[]) {
      const after = typeof d?.toObject === "function" ? plain(d) : (d as unknown as Plain);
      writeChange({ action: "create", entity: name, doc: after, snapshot: after });
    }
  });

  // ---- query updates: snapshot matching records before, compare after
  const UPDATE_OPS = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"] as const;
  for (const op of UPDATE_OPS) {
    schema.pre(op, async function (this: mongoose.Query<unknown, unknown> & { _auditBefore?: Plain[] }) {
      if (EXCLUDED_MODELS.has(this.model.modelName) || !isAuditing()) return;
      this._auditBefore = (await this.model.find(this.getFilter()).limit(MAX_DOCS_PER_QUERY).lean()) as Plain[];
    });
    schema.post(op, async function (this: mongoose.Query<unknown, unknown> & { _auditBefore?: Plain[] }) {
      const before = this._auditBefore;
      if (!before?.length) return;
      const name = this.model.modelName;
      const afterDocs = (await this.model.find({ _id: { $in: before.map((d) => d._id) } }).lean()) as Plain[];
      const byId = new Map(afterDocs.map((d) => [String(d._id), d]));
      for (const b of before) {
        const a = byId.get(String(b._id));
        if (!a) continue;
        const changes = diffSnapshots(b, a);
        if (changes.length) writeChange({ action: "update", entity: name, doc: a, changes });
      }
    });
  }

  // ---- query deletes: snapshot what's about to be removed
  const DELETE_OPS = ["deleteOne", "deleteMany", "findOneAndDelete"] as const;
  for (const op of DELETE_OPS) {
    schema.pre(op, { document: false, query: true }, async function (this: mongoose.Query<unknown, unknown> & { _auditBefore?: Plain[] }) {
      if (EXCLUDED_MODELS.has(this.model.modelName) || !isAuditing()) return;
      this._auditBefore = (await this.model.find(this.getFilter()).limit(MAX_DOCS_PER_QUERY).lean()) as Plain[];
    });
    schema.post(op, { document: false, query: true }, function (this: mongoose.Query<unknown, unknown> & { _auditBefore?: Plain[] }) {
      const before = this._auditBefore;
      if (!before?.length) return;
      for (const b of before) writeChange({ action: "delete", entity: this.model.modelName, doc: b, snapshot: b });
    });
  }
};

let registered = false;
/** Must run before any model is compiled (imported first in index.ts). */
export const registerAuditPlugin = () => {
  if (registered) return;
  registered = true;
  mongoose.plugin(auditPlugin);
};

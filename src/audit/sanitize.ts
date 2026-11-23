/**
 * Makes values safe + compact for the audit log: hides secrets, replaces uploaded file data,
 * shortens very long text and huge arrays.
 */
const SECRET_KEY = /pass(word)?|token|secret|otp|cvv|cardnumber|apikey|api_key|authorization|clientsecret/i;
const MAX_STRING = 2000;
const MAX_ARRAY = 60;
const MAX_DEPTH = 6;

export const sanitizeForAudit = (value: unknown, depth = 0, key = ""): unknown => {
  if (key && SECRET_KEY.test(key)) return value === undefined || value === null || value === "" ? value : "[hidden]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(value)) return "[uploaded file data]";
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more chars]` : value;
  }
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `[raw data, ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  // ObjectId / Decimal128 etc.
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === "ObjectId" || ctor === "ObjectID") return String(value);
  if (typeof (value as { toHexString?: () => string }).toHexString === "function") return String(value);
  if (value instanceof Map) value = Object.fromEntries(value.entries());
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => sanitizeForAudit(v, depth + 1));
    if (value.length > MAX_ARRAY) arr.push(`[… ${value.length - MAX_ARRAY} more]`);
    return arr;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "__v") continue;
    out[k] = sanitizeForAudit(v, depth + 1, k);
  }
  return out;
};

const IGNORED_FIELDS = new Set(["updatedAt", "__v"]);

/** Field-by-field differences between two plain snapshots (top-level fields). */
export const diffSnapshots = (before: Record<string, unknown> = {}, after: Record<string, unknown> = {}) => {
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k)) continue;
    const a = sanitizeForAudit(before[k], 0, k);
    const b = sanitizeForAudit(after[k], 0, k);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field: k, before: a, after: b });
  }
  return changes;
};

/** A readable name for a record: customer / person / title / code. */
export const recordLabel = (doc: Record<string, unknown> | null | undefined): string => {
  if (!doc) return "";
  const pick = ["customerName", "name", "title", "eventName", "code", "guestName", "email", "slug"].map((k) => doc[k]).find((v) => typeof v === "string" && v);
  return String(pick || "");
};

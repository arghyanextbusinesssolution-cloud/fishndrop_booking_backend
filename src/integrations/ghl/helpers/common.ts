/** Mongoose doc / plain object → string id. */
export const toId = (entity: any): string => entity?._id?.toString?.() || entity?.id || "";

/** Last 6 chars, upper-cased — safe to log, used as human booking reference. */
export const shortRef = (id: string): string => (id.length >= 6 ? id.slice(-6).toUpperCase() : id);

export const splitName = (fullName: unknown, firstFallback = ""): { name: string; firstName: string; lastName: string } => {
  const name = String(fullName || "").trim();
  const parts = name.split(" ");
  return {
    name,
    firstName: parts[0] || firstFallback,
    lastName: parts.slice(1).join(" ") || ""
  };
};

export const getOrdinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const nowIso = (): string => new Date().toISOString();

/** New York date helpers for the AI assistant (all dates are "YYYY-MM-DD", times "HH:MM" 24h). */

const TZ = "America/New_York";

export const nyToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** Minutes since midnight right now in New York. */
export const nyNowMinutes = (): number => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return h * 60 + m;
};

export const addDaysYmd = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** "Sat, Dec 12" (year added when it isn't the current year). */
export const prettyDate = (ymd: string): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  const sameYear = ymd.slice(0, 4) === nyToday().slice(0, 4);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" })
  });
};

export const weekday = (ymd: string): string =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });

/** "20:00" → "8 PM", "13:30" → "1:30 PM" */
export const to12h = (hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h % 24 >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
};

/** End clock time for a start + duration ("20:00", 5 → "01:00"). */
export const endTime = (start: string, hours: number): string => {
  const [h, m] = start.split(":").map(Number);
  const total = (h * 60 + m + Math.round(hours * 60)) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export const isValidYmd = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Accepts "20:00", "8:00", "8 PM", "8pm", "8:30 pm" → "HH:MM" 24h, or null. */
export const normalizeTime = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\./g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

/** A small calendar the model can read instead of doing weekday maths itself. */
export const upcomingCalendar = (days = 45): string => {
  const today = nyToday();
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(today, i);
    const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    lines.push(`${weekday(ymd).slice(0, 3)} ${ymd}${label}`);
  }
  return lines.join(", ");
};

/** Date of birth is stored as a plain calendar date "YYYY-MM-DD" (no timezone). */
export const DOB_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date for someone aged 13–110. */
export const isValidDob = (v: string): boolean => {
  const m = DOB_RE.exec(v || "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
  const age = (Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
  return age >= 13 && age <= 110;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Birthday bonus: is the event within this many days of the customer's birthday? */
export const BIRTHDAY_WINDOW_DAYS = 7;

/** Birthday fields for GHL, from a "YYYY-MM-DD" date of birth and the event / booking date. */
export const birthdayFields = (dob: unknown, eventDate: unknown) => {
  const m = DOB_RE.exec(String(dob || ""));
  if (!m) return { dateOfBirth: "", birthMonth: "", birthDay: "", ageAtEvent: "", birthdayNearEvent: false, birthdayDaysFromEvent: "" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const parsed = eventDate ? new Date(eventDate as string) : new Date();
  const ev = isNaN(parsed.getTime()) ? new Date() : parsed;
  const evY = ev.getUTCFullYear();
  const evDay = Date.UTC(evY, ev.getUTCMonth(), ev.getUTCDate());
  // Nearest birthday to the event (handles events around New Year)
  const nearest = [evY - 1, evY, evY + 1]
    .map((yr) => Date.UTC(yr, mo - 1, d))
    .reduce((a, b) => (Math.abs(b - evDay) < Math.abs(a - evDay) ? b : a));
  const daysFrom = Math.round((nearest - evDay) / 86400000);
  const ageAtEvent = evY - y - (evDay < Date.UTC(evY, mo - 1, d) ? 1 : 0);
  return {
    dateOfBirth: m[0],
    birthMonth: MONTHS[mo - 1],
    birthDay: d,
    ageAtEvent,
    birthdayNearEvent: Math.abs(daysFrom) <= BIRTHDAY_WINDOW_DAYS,
    birthdayDaysFromEvent: daysFrom
  };
};

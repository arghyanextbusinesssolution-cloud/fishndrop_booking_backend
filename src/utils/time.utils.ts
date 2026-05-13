export const TIME_SLOTS = ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"];

export const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

export const isOverlapping = (
  time1: string,
  duration1Mins: number,
  time2: string,
  duration2Mins: number
): boolean => {
  const start1 = timeToMinutes(time1);
  const end1 = start1 + duration1Mins;
  const start2 = timeToMinutes(time2);
  const end2 = start2 + duration2Mins;
  return start1 < end2 && start2 < end1;
};

export const buildDayRange = (inputDate: string) => {
  let year: number, month: number, day: number;

  // Only parse manually if it's a simple YYYY-MM-DD or MM/DD/YYYY string
  // ISO strings (with T) should go to the native parser
  if (inputDate.length <= 10 && (inputDate.includes("-") || inputDate.includes("/"))) {
    const parts = inputDate.split(/[-/]/).map(Number);
    if (parts.length === 3) {
      if (parts[0] > 1000) { // YYYY-MM-DD
        [year, month, day] = parts;
      } else { // MM-DD-YYYY or DD-MM-YYYY
        [month, day, year] = parts;
      }
    } else {
      const d = new Date(inputDate);
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
      day = d.getUTCDate();
    }
  } else {
    const d = new Date(inputDate);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }

  // Force UTC midnight
  const parsedDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const dayStart = new Date(parsedDate);
  const dayEnd = new Date(parsedDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  return { parsedDate, dayStart, dayEnd };
};

export const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

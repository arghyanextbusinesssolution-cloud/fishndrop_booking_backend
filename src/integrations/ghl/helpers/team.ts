import User from "../../../models/User";

export interface TeamContact {
  name?: string;
  email?: string;
  phone?: string;
}

let cache: { at: number; list: TeamContact[] } | null = null;
const TTL_MS = 60_000;

/** All employees (staff role), oldest first. Cached for a minute so busy webhooks don't hit the DB each time. */
export const getEmployeeContacts = async (): Promise<TeamContact[]> => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const list = (await User.find({ role: "staff" }).select("name email phone").sort({ createdAt: 1 }).lean()) as TeamContact[];
  cache = { at: Date.now(), list };
  return list;
};

/** Call after creating/deleting employees so the next webhook has the current team. */
export const clearEmployeeContactsCache = () => {
  cache = null;
};

/**
 * Flat fields GHL can map directly:
 * employeeCount, employee1Name/Email/Phone, employee2…, employeeEmails, employeePhones, employees[]
 */
export const employeeFields = (employees: TeamContact[] = []) => {
  const team = employees.filter((e) => e && (e.email || e.phone));
  const fields: Record<string, unknown> = { employeeCount: team.length };
  team.forEach((e, i) => {
    fields[`employee${i + 1}Name`] = e.name || "";
    fields[`employee${i + 1}Email`] = e.email || "";
    fields[`employee${i + 1}Phone`] = e.phone || "";
  });
  fields.employeeEmails = team.map((e) => e.email).filter(Boolean).join(", ");
  fields.employeePhones = team.map((e) => e.phone).filter(Boolean).join(", ");
  fields.employees = team.map((e) => ({ name: e.name || "", email: e.email || "", phone: e.phone || "" }));
  return fields;
};

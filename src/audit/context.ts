import { AsyncLocalStorage } from "async_hooks";

/**
 * Per-request audit context (who is acting, which request) — available anywhere in the request,
 * including Mongoose hooks, without passing it around.
 */
export interface AuditActor {
  id?: string;
  name: string;
  email?: string;
  role: string;
}

export interface AuditStore {
  requestId: string;
  method: string;
  path: string;
  ip: string;
  userAgent: string;
  /** Express request — req.user is filled in later by the auth middleware */
  req: { user?: { id?: string; name?: string; email?: string; role?: string } };
  /** Set for webhooks / automated callers (no logged-in user) */
  system?: AuditActor;
}

export const auditStorage = new AsyncLocalStorage<AuditStore>();

/** Roles whose actions are audited (customers' own actions are not). */
const AUDITED_ROLES = new Set(["admin", "owner", "staff", "employee", "promoter", "seo", "venue_owner"]);

export const currentAudit = (): AuditStore | undefined => auditStorage.getStore();

/** The acting staff member / system for the current request, or null when it shouldn't be audited. */
export const currentActor = (store = currentAudit()): AuditActor | null => {
  if (!store) return null;
  if (store.system) return store.system;
  const u = store.req.user;
  if (!u?.role || !AUDITED_ROLES.has(u.role)) return null;
  return { id: u.id, name: u.name || u.email || "Staff", email: u.email, role: u.role };
};

/** True while handling a create / change / delete request by staff or a webhook. */
export const isAuditing = (): boolean => {
  const store = currentAudit();
  if (!store || ["GET", "HEAD", "OPTIONS"].includes(store.method)) return false;
  return Boolean(currentActor(store));
};

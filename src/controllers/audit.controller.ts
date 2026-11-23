import { NextFunction, Request, Response } from "express";
import AuditLog from "../models/AuditLog";

/**
 * GET /api/admin/audit-logs   (admin / owner)
 * Query: page, limit, q (actor, endpoint, record name/id), role, entity, action (create|update|delete),
 *        status (ok|failed), from, to (YYYY-MM-DD, New York days)
 * Returns staff/webhook actions newest first, each with the record changes it caused.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const listAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 30));
    const q = String(req.query.q || "").trim().slice(0, 100);
    const role = String(req.query.role || "");
    const entity = String(req.query.entity || "");
    const action = String(req.query.action || "");
    const status = String(req.query.status || "");
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    const match: Record<string, unknown> = { kind: "request" };
    const at: Record<string, Date> = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) at.$gte = new Date(`${from}T00:00:00-05:00`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) at.$lte = new Date(`${to}T23:59:59-05:00`);
    if (Object.keys(at).length) match.at = at;
    if (role) match["actor.role"] = role;
    if (status === "ok") match.statusCode = { $lt: 400 };
    if (status === "failed") match.statusCode = { $gte: 400 };

    // Filters on the records touched → limit to requests that changed such records
    const changeFilter: Record<string, unknown> = { kind: "change" };
    if (entity) changeFilter.entity = entity;
    if (["create", "update", "delete"].includes(action)) changeFilter.action = action;
    const needsChangeFilter = Boolean(entity || ["create", "update", "delete"].includes(action));

    const or: Record<string, unknown>[] = [];
    if (q) {
      const re = new RegExp(escapeRe(q), "i");
      or.push({ "actor.name": re }, { "actor.email": re }, { path: re }, { responseMessage: re });
      // record name / id matches
      const ids = await AuditLog.distinct("requestId", { kind: "change", $or: [{ entityLabel: re }, { entityId: q }] });
      if (ids.length) or.push({ requestId: { $in: ids.slice(0, 2000) } });
    }
    if (needsChangeFilter) {
      const ids = await AuditLog.distinct("requestId", changeFilter);
      match.requestId = { $in: ids.slice(0, 5000) };
    }
    if (or.length) match.$or = or;

    const [total, requests] = await Promise.all([
      AuditLog.countDocuments(match),
      AuditLog.find(match).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean()
    ]);
    const changes = await AuditLog.find({ kind: "change", requestId: { $in: requests.map((r) => r.requestId) } })
      .sort({ at: 1 })
      .lean();
    const byRequest = new Map<string, unknown[]>();
    for (const c of changes) {
      const list = byRequest.get(c.requestId) || [];
      list.push(c);
      byRequest.set(c.requestId, list);
    }

    const [entities, roles] = await Promise.all([AuditLog.distinct("entity", { kind: "change" }), AuditLog.distinct("actor.role", { kind: "request" })]);

    res.json({
      success: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      filters: { entities: entities.filter(Boolean).sort(), roles: roles.filter(Boolean).sort() },
      items: requests.map((r) => ({ ...r, changes: byRequest.get(r.requestId) || [] }))
    });
  } catch (error) {
    next(error);
  }
};

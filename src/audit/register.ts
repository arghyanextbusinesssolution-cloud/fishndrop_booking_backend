// Imported FIRST in index.ts — the audit plugin must be registered before any Mongoose model is compiled.
import { registerAuditPlugin } from "./plugin";

registerAuditPlugin();
// The log model itself (plugin skips it) — compiled now so logs can be written from the first request
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("../models/AuditLog");

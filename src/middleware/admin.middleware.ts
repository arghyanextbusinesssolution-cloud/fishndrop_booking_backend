import { NextFunction, Request, Response } from "express";

const adminOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "owner")) {
    res.status(403).json({ success: false, message: "Forbidden: Admin or Owner access required." });
    return;
  }
  next();
};

export const staffOrAdminOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  const role = req.user.role;
  if (role !== "admin" && role !== "owner" && role !== "staff") {
    res.status(403).json({ success: false, message: "Forbidden: Staff, Admin, or Owner access required." });
    return;
  }
  next();
};

/** Blog module: admin/owner, plus the SEO team (role "seo") who can ONLY manage blogs. */
export const blogEditorOnly = (req: Request, res: Response, next: NextFunction): void => {
  const role = req.user?.role;
  if (role !== "admin" && role !== "owner" && role !== "seo") {
    res.status(403).json({ success: false, message: "Forbidden: blog editor access required." });
    return;
  }
  next();
};

export default adminOnly;

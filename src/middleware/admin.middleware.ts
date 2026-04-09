import { NextFunction, Request, Response } from "express";

const adminOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }
  next();
};

export default adminOnly;

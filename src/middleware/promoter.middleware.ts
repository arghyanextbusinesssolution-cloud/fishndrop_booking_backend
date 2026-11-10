import { NextFunction, Request, Response } from "express";

export const promoterOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const role = req.user.role;
  if (role !== "promoter" && role !== "admin" && role !== "owner") {
    res.status(403).json({
      success: false,
      message: "Forbidden: Promoter or Admin access required."
    });
    return;
  }

  next();
};

export const approvedPromoterOnly = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const role = req.user.role;
  if (role === "admin" || role === "owner") {
    next();
    return;
  }

  if (role !== "promoter") {
    res.status(403).json({
      success: false,
      message: "Forbidden: Promoter access required."
    });
    return;
  }

  const User = (await import("../models/User")).default;
  const user = await User.findById(req.user._id);

  if (!user || user.promoterStatus !== "approved") {
    res.status(403).json({
      success: false,
      code: "PROMOTER_NOT_APPROVED",
      message: "Your promoter account is pending verification and approval by the Tropica team."
    });
    return;
  }

  next();
};


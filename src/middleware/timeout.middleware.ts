import { NextFunction, Request, Response } from "express";

const timeoutMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, message: "Request timed out. Please try again." });
    }
  }, timeoutMs);

  res.on("finish", () => {
    clearTimeout(timer);
  });

  next();
};

export default timeoutMiddleware;

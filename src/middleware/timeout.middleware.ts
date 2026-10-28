import { NextFunction, Request, Response } from "express";

const timeoutMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, message: "Request timed out. Please try again." });
    }
  }, timeoutMs);

  const clear = () => clearTimeout(timer);
  res.on("finish", clear);
  res.on("close", clear);

  next();
};

export default timeoutMiddleware;

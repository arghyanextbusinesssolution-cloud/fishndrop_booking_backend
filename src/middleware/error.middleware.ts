import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import logger from "../config/logger";

interface MongoDuplicateError extends Error {
  code?: number;
  keyValue?: Record<string, unknown>;
}

const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction): void => {
  logger.error("Unhandled error", { message: err.message, stack: err.stack, path: req.originalUrl, method: req.method });

  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ success: false, message: "Invalid ID format" });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((validationError) => ({
      field: validationError.path,
      message: validationError.message
    }));
    res.status(422).json({ success: false, message: "Validation failed", errors: details });
    return;
  }

  const duplicateErr = err as MongoDuplicateError;
  if (duplicateErr.code === 11000) {
    res.status(409).json({ success: false, message: "Resource already exists" });
    return;
  }

  if (process.env.NODE_ENV === "production") {
    res.status(500).json({ success: false, message: "Internal server error" });
    return;
  }

  res.status(500).json({ success: false, message: err.message, stack: err.stack });
};

export default errorMiddleware;

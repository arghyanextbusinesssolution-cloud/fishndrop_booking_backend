import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";

const validate = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({
      success: false,
      errors: errors.array().map((error) => ({
        field: "path" in error ? error.path : "unknown",
        message: error.msg
      }))
    });
    return;
  }
  next();
};

export default validate;

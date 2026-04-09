import { NextFunction, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import User from "../models/User";

interface TokenPayload extends JwtPayload {
  id: string;
}

import logger from "../config/logger";

const authMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  logger.info(`AUTH CHECK: ${req.method} ${req.originalUrl}`);
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as TokenPayload;
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    req.user = {
      id: user._id.toString(),
      _id: user._id,
      role: user.role,
      email: user.email,
      name: user.name
    };
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: "Unauthorized" });
  }
};

export default authMiddleware;

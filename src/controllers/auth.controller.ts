import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = sanitizeString(req.body.name);
    const email = sanitizeString(req.body.email).toLowerCase();
    const phone = sanitizeString(req.body.phone);
    const password = sanitizeString(req.body.password);

    const existingUser = await User.findOne({ email }).select("-password");
    if (existingUser) {
      res.status(409).json({ success: false, message: "User already exists" });
      return;
    }

    const user = await User.create({ name, email, password, phone });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
      expiresIn: "7d"
    });

    res.status(201).json({ 
      success: true, 
      message: "Registered successfully", 
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
    });
  } catch (error) {
    next(new Error("Registration failed"));
  }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const email = sanitizeString(req.body.email).toLowerCase();
    const password = sanitizeString(req.body.password);

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
      expiresIn: "7d"
    });

    res.status(200).json({
      success: true,
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
    });
  } catch (error) {
    next(new Error("Login failed"));
  }
};
export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    res.status(200).json({ success: true, user: req.user });
  } catch (error) {
    next(new Error("Failed to fetch profile"));
  }
};

export const checkEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const user = await User.findOne({ email });
    res.status(200).json({ success: true, exists: !!user });
  } catch (error) {
    next(new Error("Failed to check email"));
  }
};

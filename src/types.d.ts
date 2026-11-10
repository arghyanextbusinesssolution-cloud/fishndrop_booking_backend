import { Types } from "mongoose";

export interface UserPayload {
  id: string;
  role: "user" | "admin" | "owner" | "staff" | "promoter";
  email?: string;
  name?: string;
  phone?: string;
  isPhoneVerified?: boolean;
  companyName?: string;
  promoterStatus?: "pending" | "approved" | "rejected";
  stripeConnectOnboarded?: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  createdAt?: Date | string;
  _id: Types.ObjectId;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: UserPayload;
  }
}


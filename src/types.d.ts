import { Types } from "mongoose";

export interface UserPayload {
  id: string;
  role: "user" | "admin" | "owner" | "staff" | "promoter" | "seo" | "venue_owner";
  email?: string;
  name?: string;
  phone?: string;
  isPhoneVerified?: boolean;
      dateOfBirth?: string;
  companyName?: string;
  promoterStatus?: "pending" | "approved" | "rejected";
  stripeConnectOnboarded?: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  partnerVenue?: Types.ObjectId;
  createdAt?: Date | string;
  _id: Types.ObjectId;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: UserPayload;
  }
}


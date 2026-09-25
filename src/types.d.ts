import { Types } from "mongoose";

export interface UserPayload {
  id: string;
  role: "user" | "admin";
  email?: string;
  name?: string;
  phone?: string;
  _id: Types.ObjectId;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: UserPayload;
  }
}

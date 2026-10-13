import { Document, Schema, model } from "mongoose";

export interface IOtpCode extends Document {
  phone: string;
  code: string;
  expiresAt: Date;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

const otpCodeSchema = new Schema<IOtpCode>(
  {
    phone: { type: String, required: true, unique: true, index: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
    timestamp: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

const OtpCode = model<IOtpCode>("OtpCode", otpCodeSchema);

export default OtpCode;

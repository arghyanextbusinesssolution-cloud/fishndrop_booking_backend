import bcrypt from "bcryptjs";
import { Document, Model, Schema, Types, model } from "mongoose";

export interface IUser extends Document {
  name?: string;
  email?: string;
  phone?: string;
  password?: string;
  role: "user" | "admin" | "owner" | "staff" | "promoter";
  otpCode?: string;
  otpExpires?: Date;
  isPhoneVerified?: boolean;
  // Promoter specific fields
  companyName?: string;
  idDocumentUrl?: string;
  promoterStatus?: "pending" | "approved" | "rejected";
  promoterApprovedBy?: Types.ObjectId;
  promoterApprovedAt?: Date;
  promoterRejectionReason?: string;
  stripeConnectAccountId?: string;
  stripeConnectOnboarded?: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  platformFeeOverride?: number;
  comparePassword(candidate: string): Promise<boolean>;
}

interface IUserModel extends Model<IUser> {}

const userSchema = new Schema<IUser, IUserModel>(
  {
    name: { type: String, trim: true, maxlength: 100 },
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    password: { type: String, required: false, select: false },
    phone: { type: String, required: false, trim: true, unique: true, sparse: true },
    role: { type: String, enum: ["user", "admin", "owner", "staff", "promoter"], default: "user" },
    otpCode: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    isPhoneVerified: { type: Boolean, default: false },
    // Promoter verification and Stripe Connect
    companyName: { type: String, trim: true, maxlength: 150 },
    idDocumentUrl: { type: String, trim: true },
    promoterStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: undefined
    },
    promoterApprovedBy: { type: Schema.Types.ObjectId, ref: "User" },
    promoterApprovedAt: { type: Date },
    promoterRejectionReason: { type: String, trim: true, maxlength: 500 },
    stripeConnectAccountId: { type: String, trim: true },
    stripeConnectOnboarded: { type: Boolean, default: false },
    chargesEnabled: { type: Boolean, default: false },
    payoutsEnabled: { type: Boolean, default: false },
    platformFeeOverride: { type: Number, min: 0, max: 100 }
  },
  { timestamps: true }
);

userSchema.pre("save", async function hashPassword() {
  if (!this.password || !this.isModified("password")) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function comparePassword(candidate: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

const User = model<IUser, IUserModel>("User", userSchema);
export default User;

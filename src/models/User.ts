import bcrypt from "bcryptjs";
import { Document, Model, Schema, model } from "mongoose";

export interface IUser extends Document {
  name?: string;
  email?: string;
  phone: string;
  password?: string;
  role: "user" | "admin";
  otpCode?: string;
  otpExpires?: Date;
  isPhoneVerified?: boolean;
  comparePassword(candidate: string): Promise<boolean>;
}

interface IUserModel extends Model<IUser> {}

const userSchema = new Schema<IUser, IUserModel>(
  {
    name: { type: String, trim: true, maxlength: 50 },
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    password: { type: String, required: false, select: false },
    phone: { type: String, required: true, trim: true, unique: true, sparse: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    otpCode: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    isPhoneVerified: { type: Boolean, default: false }
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

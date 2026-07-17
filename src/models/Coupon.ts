import { Document, Schema, Types, model } from "mongoose";

export interface ICoupon extends Document {
    code: string;
    promoterName: string;
    promoterEmail: string;
    promoterPhone?: string;
    discountType: "percentage" | "fixed";
    discountValue: number;
    status: "active" | "inactive";
    usageLimit?: number;
    usageCount: number;
    expiryDate?: Date;
    notes?: string;
    commissionType?: "percentage" | "fixed";
    commissionValue?: number;
    createdBy: Types.ObjectId;
}

const couponSchema = new Schema<ICoupon>(
    {
        code: { type: String, required: true, unique: true, trim: true, uppercase: true },
        promoterName: { type: String, required: true, trim: true },
        promoterEmail: { type: String, required: true, trim: true, lowercase: true },
        promoterPhone: { type: String, trim: true },
        discountType: { type: String, enum: ["percentage", "fixed"], required: true },
        discountValue: { type: Number, required: true, min: 0 },
        status: { type: String, enum: ["active", "inactive"], default: "active" },
        usageLimit: { type: Number },
        usageCount: { type: Number, default: 0 },
        expiryDate: { type: Date },
        notes: { type: String },
        commissionType: { type: String, enum: ["percentage", "fixed"] },
        commissionValue: { type: Number, min: 0 },
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

couponSchema.index({ code: 1 });
couponSchema.index({ status: 1 });

const Coupon = model<ICoupon>("Coupon", couponSchema);
export default Coupon;

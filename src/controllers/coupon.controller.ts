import { Request, Response } from "express";
import Coupon from "../models/Coupon";

export const createCoupon = async (req: Request, res: Response): Promise<void> => {
    try {
        const {
            code,
            promoterName,
            promoterEmail,
            promoterPhone,
            discountType,
            discountValue,
            usageLimit,
            expiryDate,
            notes,
            commissionType,
            commissionValue
        } = req.body;

        const existing = await Coupon.findOne({ code: code.toUpperCase() });
        if (existing) {
            res.status(400).json({ success: false, message: "Coupon code already exists" });
            return;
        }

        const coupon = await Coupon.create({
            code: code.toUpperCase(),
            promoterName,
            promoterEmail,
            promoterPhone,
            discountType,
            discountValue,
            usageLimit,
            expiryDate,
            notes,
            commissionType,
            commissionValue,
            createdBy: req.user?._id,
            status: "active"
        });

        res.status(201).json({ success: true, coupon });
    } catch (error: any) {
        console.error("[Create Coupon Error]:", error);
        res.status(500).json({ success: false, message: "Failed to create coupon" });
    }
};

export const getCoupons = async (req: Request, res: Response): Promise<void> => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 });
        res.status(200).json({ success: true, coupons });
    } catch (error: any) {
        console.error("[Get Coupons Error]:", error);
        res.status(500).json({ success: false, message: "Failed to fetch coupons" });
    }
};

export const getCoupon = async (req: Request, res: Response): Promise<void> => {
    try {
        const coupon = await Coupon.findById(req.params.id);
        if (!coupon) {
            res.status(404).json({ success: false, message: "Coupon not found" });
            return;
        }
        res.status(200).json({ success: true, coupon });
    } catch (error: any) {
        console.error("[Get Coupon Error]:", error);
        res.status(500).json({ success: false, message: "Failed to fetch coupon" });
    }
};

export const updateCoupon = async (req: Request, res: Response): Promise<void> => {
    try {
        const updates = { ...req.body };
        if (updates.code) updates.code = updates.code.toUpperCase();

        const coupon = await Coupon.findByIdAndUpdate(req.params.id, updates, { new: true });
        if (!coupon) {
            res.status(404).json({ success: false, message: "Coupon not found" });
            return;
        }

        res.status(200).json({ success: true, coupon });
    } catch (error: any) {
        console.error("[Update Coupon Error]:", error);
        res.status(500).json({ success: false, message: "Failed to update coupon" });
    }
};

export const deleteCoupon = async (req: Request, res: Response): Promise<void> => {
    try {
        const coupon = await Coupon.findByIdAndDelete(req.params.id);
        if (!coupon) {
            res.status(404).json({ success: false, message: "Coupon not found" });
            return;
        }
        res.status(200).json({ success: true, message: "Coupon deleted successfully" });
    } catch (error: any) {
        console.error("[Delete Coupon Error]:", error);
        res.status(500).json({ success: false, message: "Failed to delete coupon" });
    }
};

export const getCouponStatistics = async (req: Request, res: Response): Promise<void> => {
    try {
        // Basic statistics for now, expandable later
        const stats = await Coupon.aggregate([
            {
                $group: {
                    _id: null,
                    totalCoupons: { $sum: 1 },
                    activeCoupons: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
                    totalUsage: { $sum: "$usageCount" }
                }
            }
        ]);
        res.status(200).json({ success: true, stats: stats[0] || { totalCoupons: 0, activeCoupons: 0, totalUsage: 0 } });
    } catch (error: any) {
        console.error("[Coupon Statistics Error]:", error);
        res.status(500).json({ success: false, message: "Failed to fetch statistics" });
    }
};

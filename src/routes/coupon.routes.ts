import { Router } from "express";
import {
    createCoupon,
    getCoupons,
    getCoupon,
    updateCoupon,
    deleteCoupon,
    getCouponStatistics
} from "../controllers/coupon.controller";

const router = Router();

// Middlewares are applied in admin.routes.ts, so we don't need them here.
router.get("/statistics", getCouponStatistics);
router.route("/")
    .post(createCoupon)
    .get(getCoupons);

router.route("/:id")
    .get(getCoupon)
    .put(updateCoupon)
    .delete(deleteCoupon);

export default router;

import cron from "node-cron";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import logger from "../config/logger";
import {
    sendRemainingBalanceReminderViaEmailJS,
    sendRemainingBalanceCancellationViaEmailJS
} from "../utils/email.utils";

export const startReminderCron = () => {
    logger.info("Initializing 48-hour email reminder cron job...");

    // Runs every hour
    cron.schedule("0 * * * *", async () => {
        try {
            const now = new Date();
            // Confirmed bookings where paymentStatus is deposit_paid and remaining balance is unpaid
            const bookings = await Booking.find({
                bookingType: "private_event",
                status: "confirmed",
                paymentStatus: "deposit_paid",
                remainingPaymentStatus: "unpaid"
            });

            for (const booking of bookings) {
                const bookingTimeMs = new Date(booking.bookingDate).getTime();
                const [hours, minutes] = booking.bookingTime.split(":").map(Number);
                const bookingDateTime = new Date(bookingTimeMs);
                bookingDateTime.setHours(hours, minutes, 0, 0);

                const diffMs = bookingDateTime.getTime() - now.getTime();
                const diffMins = diffMs / (1000 * 60);

                // Remaining Payment Reminder: 48 hours (2880 mins) or less before the booking
                if (diffMins > 0 && diffMins <= (48 * 60) && !booking.remainingPaymentReminderSent) {
                    logger.info(`[Reminder Cron] Sending 48-hour remaining balance reminder for private event booking ${booking._id}`);

                    const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
                    // Deep link specifically built for the user payment interface
                    const paymentLink = `${baseUrl}/user/payment?is_balance=true&bookingId=${booking._id}`;

                    booking.remainingPaymentReminderSent = true;
                    await booking.save();

                    void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
                }

                // Remaining Payment Cancellation: 24 hours (1440 mins) or less before the booking
                if (diffMins > 0 && diffMins <= (24 * 60)) {
                    logger.warn(`[Reminder Cron] Auto-cancelling private event booking ${booking._id} due to unpaid remaining balance within 24hr window`);

                    booking.status = "cancelled";
                    await booking.save();

                    // Release slot locks
                    await SlotLock.deleteMany({ eventId: booking._id });

                    void sendRemainingBalanceCancellationViaEmailJS(booking);
                }
            }
        } catch (err) {
            logger.error("[Reminder Cron Error] failed during auto-payment review:", err);
        }
    });
};

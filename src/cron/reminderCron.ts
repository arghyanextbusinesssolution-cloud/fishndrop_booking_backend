import cron from "node-cron";
import { getFrontendBaseUrl } from "../utils/siteUrl";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import TicketOrder from "../models/TicketOrder";
import Event from "../models/Event";
import logger from "../config/logger";
import {
    sendRemainingBalanceReminderViaEmailJS,
    sendRemainingBalanceCancellationViaEmailJS
} from "../utils/email.utils";
import { cleanupExpiredPendingBookings } from "../utils/cleanupExpiredBookings";
import { reconcileCalendar } from "../services/calendarSync.service";
import { isGoogleCalendarEnabled } from "../services/googleCalendar.service";
import { scheduleAvailabilitySync } from "../integrations/ghl/triggers/availability/availabilityUpdated.trigger";

export const startReminderCron = () => {
    logger.info("Initializing 72-hour email reminder & 15-min unpaid booking cleanup cron jobs...");

    // Google Calendar safety net: retry failed syncs and catch changes made via bulk updates
    cron.schedule("*/5 * * * *", () => {
        void reconcileCalendar();
    });
    isGoogleCalendarEnabled(); // prints "✓ Enabled → calendar …" or "✗ Sync SKIPPED — …" at boot
    setTimeout(() => void reconcileCalendar(), 15_000); // initial backfill shortly after boot

    // GHL AI: re-publish the next-90-days blocked slots daily (6 AM NY) so the window rolls forward
    cron.schedule("0 6 * * *", () => scheduleAvailabilitySync("daily_refresh"), { timezone: "America/New_York" });

    // Auto-cleanup unpaid pending draft bookings every 2 minutes
    cron.schedule("*/2 * * * *", async () => {
        try {
            await cleanupExpiredPendingBookings();
        } catch (err) {
            logger.error("[Auto-Cleanup Cron Error]", err);
        }
    });


    // Cleanup expired pending ticket orders every 3 minutes
    cron.schedule("*/3 * * * *", async () => {
        try {
            const expiredOrders = await TicketOrder.find({
                status: "pending",
                expiresAt: { $lt: new Date() }
            });

            const { releaseOrderReservation, fulfillTicketOrder } = await import("../controllers/ticketPurchase.controller");
            const { getStripe } = await import("../utils/stripe.utils");
            const stripe = getStripe();

            for (const order of expiredOrders) {
                try {
                    // Embedded payments: make sure the PaymentIntent can't be paid after we free the seats
                    if (stripe && order.stripePaymentIntentId && !order.stripeCheckoutSessionId) {
                        const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
                        if (intent.status === "succeeded") {
                            await fulfillTicketOrder(order._id.toString(), intent.id);
                            continue;
                        }
                        if (intent.status === "processing") continue; // decide when it settles
                        if (intent.status !== "canceled") {
                            await stripe.paymentIntents.cancel(intent.id).catch(() => undefined);
                        }
                    }
                    await releaseOrderReservation(order._id.toString(), "failed");
                } catch (orderErr: any) {
                    logger.error(`[Ticket Cleanup] Failed for order ${order.orderNumber}`, { error: orderErr.message });
                }
            }

            if (expiredOrders.length > 0) {
                logger.info(`[Ticket Cleanup] Cleaned up ${expiredOrders.length} expired ticket orders`);
            }
        } catch (err) {
            logger.error("[Ticket Cleanup Cron Error]", err);
        }
    });

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

                // Remaining Payment Reminder: 72 hours (4320 mins) or less before the booking
                if (diffMins > 0 && diffMins <= (72 * 60) && !booking.remainingPaymentReminderSent) {
                    logger.info(`[Reminder Cron] Sending 72-hour remaining balance reminder for private event booking ${booking._id}`);

                    const baseUrl = getFrontendBaseUrl();
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

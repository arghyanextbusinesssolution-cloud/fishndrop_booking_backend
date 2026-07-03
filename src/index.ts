import "./config/loadEnv";
import compression from "compression";
import cors, { CorsOptions } from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import connectDB from "./config/db";
import logger from "./config/logger";
import errorMiddleware from "./middleware/error.middleware";
import timeoutMiddleware from "./middleware/timeout.middleware";
import adminRoutes from "./routes/admin.routes";
import authRoutes from "./routes/auth.routes";
import bookingRoutes from "./routes/booking.routes";
import paymentRoutes from "./routes/payment.routes";
import Booking from "./models/Booking";
import SlotLock from "./models/SlotLock";
import { sendRemainingBalanceReminderViaEmailJS, sendRemainingBalanceCancellationViaEmailJS } from "./utils/email.utils";

const app = express();
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.STRIPE_SECRET_KEY?.trim() && !process.env.STRIPE_SECRET?.trim() && !process.env.STRIPE_API_KEY?.trim()) {
  logger.warn(
    "Stripe secret key missing from env after loadEnv. Use a real sk_test_ secret from the Stripe Dashboard in backend/.env (documentation placeholder keys do not work)."
  );
}

void connectDB();

app.use(
  helmet({
    contentSecurityPolicy: true,
    crossOriginEmbedderPolicy: true,
    hsts: { maxAge: 31536000, includeSubDomains: true },
    noSniff: true,
    xssFilter: true
  } as never)
);

const parsedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins =
  parsedOrigins.length > 0
    ? parsedOrigins
    : [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://fishndrop.nextbusinesssolution.com",
      "https://tropica.nyc",
      "https://www.tropica.nyc",
    ];

const corsOptions: CorsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(compression());

app.use(
  morgan(isProduction ? "combined" : "dev", {
    stream: {
      write: (message: string) => {
        logger.info(message.trim());
      }
    }
  })
);

const globalRateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  max: Number(process.env.RATE_LIMIT_MAX || 100),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later" }
});

app.use((req, res, next) => {
  logger.info(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

app.use(globalRateLimiter);
app.use(timeoutMiddleware);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Backend is running from SOURCE (ts-node)",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || "development"
  });
});

// Payment routes registered before global body-parser to allow webhook raw body handling
app.use("/api/payments", paymentRoutes);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/admin", adminRoutes);

app.use((req, res) => {
  logger.warn(`[404] ${req.method} ${req.url}`);
  res.status(404).json({ success: false, message: "Route not found" });
});


app.use(errorMiddleware);

const port = Number(process.env.PORT || 5000);
app.listen(port, () => {
  logger.info(`Server started on port ${port} - RESTART_VERIFIED_UUID_1`);
  logger.info("Custom Cake feature loaded successfully");
});

// Background job to review remaining payment balances for private events.
// Runs every 30 seconds to catch 2-min reminder and 1-min cancellation windows.
setInterval(async () => {
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
      // Calculate minutes difference between booking time and now
      const bookingTimeMs = new Date(booking.bookingDate).getTime();
      const [hours, minutes] = booking.bookingTime.split(":").map(Number);
      const bookingDateTime = new Date(bookingTimeMs);
      bookingDateTime.setHours(hours, minutes, 0, 0);

      const diffMs = bookingDateTime.getTime() - now.getTime();
      const diffMins = diffMs / (1000 * 60);

      // Remaining Payment Reminder: 48 hours (2880 mins) or less before the booking
      if (diffMins > 0 && diffMins <= (48 * 60) && !booking.remainingPaymentReminderSent) {
        logger.info(`[Background Job] Sending 48-hour remaining balance reminder for private event booking ${booking._id}`);

        const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
        // Deep link to direct pay balance checkout session
        const paymentLink = `${baseUrl}/dashboard?pay_balance=${booking._id}`;

        booking.remainingPaymentReminderSent = true;
        await booking.save();

        void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
      }

      // Remaining Payment Cancellation: 24 hours (1440 mins) or less before the booking
      // if not paid, auto-cancel
      if (diffMins > 0 && diffMins <= (24 * 60)) {
        logger.warn(`[Background Job] Auto-cancelling private event booking ${booking._id} due to unpaid remaining balance within 24hr window`);

        booking.status = "cancelled";
        await booking.save();

        // Release slot locks
        await SlotLock.deleteMany({ eventId: booking._id });

        void sendRemainingBalanceCancellationViaEmailJS(booking);
      }
    }
  } catch (err) {
    logger.error("[Background Job Error] failed during auto-payment review:", err);
  }
}, 30000);


process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exit(1);
});

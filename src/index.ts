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
  parsedOrigins.length > 0 ? parsedOrigins : ["http://localhost:3000", "http://localhost:3001"];

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

app.use(globalRateLimiter);
app.use(timeoutMiddleware);

// Payment routes registered before global body-parser to allow webhook raw body handling
app.use("/api/payments", paymentRoutes);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

app.use("/api/auth", authRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/admin", adminRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use(errorMiddleware);

const port = Number(process.env.PORT || 5000);
app.listen(port, () => {
  logger.info(`Server started on port ${port} - RESTART_VERIFIED_UUID_1`);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exit(1);
});

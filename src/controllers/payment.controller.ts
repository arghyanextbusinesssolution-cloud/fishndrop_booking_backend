import type { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import Stripe from "stripe";
import { loadEnvFiles } from "../config/loadEnv";
import Booking from "../models/Booking";
import Coupon from "../models/Coupon";
import logger from "../config/logger";
import { sendPaymentEmails, sendRemainingBalanceReminderViaEmailJS, sendFullPaymentConfirmationViaEmailJS } from "../utils/email.utils";

/** Keys copied from Stripe docs — they are not real and will not work with the API. */
const INVALID_PLACEHOLDER_SECRETS = new Set([
  "sk_test_placeholder_key_alpha",
  "sk_test_placeholder_key_beta"
]);

// Lazy init: env must be read after dotenv loads (see config/loadEnv imported first in index.ts).
type StripeClient = InstanceType<typeof Stripe>;
let stripeClient: StripeClient | null = null;

function parseEnvFilesForStripeSecret(paths: string[]): string | undefined {
  for (const file of paths) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (!t.toUpperCase().startsWith("STRIPE_SECRET_KEY=")) continue;
        const v = t.slice("STRIPE_SECRET_KEY=".length).trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

function isUsableSecret(key: string | undefined): key is string {
  if (!key?.trim()) return false;
  if (INVALID_PLACEHOLDER_SECRETS.has(key.trim())) return false;
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) return false;
  if (key.length < 40) return false;
  return true;
}

function readStripeSecretKey(): string | undefined {
  let key =
    process.env.STRIPE_SECRET_KEY?.trim() ||
    process.env.STRIPE_SECRET?.trim() ||
    process.env.STRIPE_API_KEY?.trim();
  if (isUsableSecret(key)) return key;

  loadEnvFiles();
  key =
    process.env.STRIPE_SECRET_KEY?.trim() ||
    process.env.STRIPE_SECRET?.trim() ||
    process.env.STRIPE_API_KEY?.trim();
  if (isUsableSecret(key)) return key;

  const fromFile = parseEnvFilesForStripeSecret([
    path.resolve(__dirname, "../../.env"),
    path.join(process.cwd(), "backend", ".env"),
    path.join(process.cwd(), ".env")
  ]);
  if (isUsableSecret(fromFile)) return fromFile;
  return undefined;
}

function getStripe(): StripeClient | null {
  const key = readStripeSecretKey();
  if (!key) {
    return null;
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key, { apiVersion: "2026-03-25.dahlia" as const });
  }
  return stripeClient;
}

/**
 * Initial checkout session.
 * For private_event bookings: charges only the $200 deposit (booking.depositAmount).
 * For standard bookings: charges full amount (depositAmount == totalAmount).
 */
export const createCheckoutSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      console.error(
        "Stripe checkout unavailable: set STRIPE_SECRET_KEY in backend/.env to your real secret from https://dashboard.stripe.com/test/apikeys (not the documentation example)."
      );
      res.status(503).json({
        success: false,
        code: "STRIPE_NOT_CONFIGURED",
        message:
          "Payments are not configured. Use a real Stripe secret key in backend/.env (the short sk_test_… example from docs does not work)."
      });
      return;
    }

    const bookingId = String(req.body.bookingId || "").trim();
    if (!bookingId) {
      res.status(400).json({ success: false, message: "bookingId is required" });
      return;
    }

    const booking = await Booking.findById(bookingId).populate("tables");
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (booking.user.toString() !== req.user?._id.toString()) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    if (booking.paymentStatus === "paid") {
      res.status(400).json({ success: false, message: "This booking is already paid" });
      return;
    }

    const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
    const tableNumbers = (booking.tables as any[]).map(t => t.tableNumber).join(", ");

    // Charge deposit amount (for private events this is $200, for standard it's the full amount)
    const chargeAmount = Math.max(50, Math.round(booking.depositAmount * 100));

    const isPrivate = booking.bookingType === "private_event";
    const depositLabel = isPrivate
      ? `Security Deposit – Private Venue on ${booking.bookingDate.toLocaleDateString()} at ${booking.bookingTime}`
      : `Table Reservation for ${booking.partySize} guests on ${booking.bookingDate.toLocaleDateString()} at ${booking.bookingTime}${tableNumbers ? ` (Tables: ${tableNumbers})` : ""}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      billing_address_collection: "auto",
      customer_email: req.user?.email || booking.customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: {
              name: isPrivate ? "Tropica Venue – Security Deposit ($200)" : "Tropica Sanctuary Reservation",
              description: depositLabel
            },
            unit_amount: chargeAmount
          }
        }
      ],
      metadata: {
        bookingId: String(booking._id),
        userId: req.user!._id.toString(),
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
        partySize: String(booking.partySize),
        bookingDate: booking.bookingDate.toISOString().split("T")[0],
        bookingTime: booking.bookingTime,
        occasion: booking.occasion,
        bookingType: booking.bookingType,
        tableNumbers: tableNumbers || "N/A",
        notes: booking.notes?.substring(0, 500) || "",
        isBalancePayment: "false"
      },
      payment_intent_data: {
        description: `Tropica Booking #${bookingId.slice(-6).toUpperCase()} – ${booking.customerName} – DEPOSIT`
      },
      success_url: `${baseUrl}/user/payment/confirmed?session_id={CHECKOUT_SESSION_ID}&bookingId=${booking.id}`,
      cancel_url: `${baseUrl}/user/payment/failed?bookingId=${booking.id}&reason=cancelled`
    });

    res.status(201).json({ success: true, url: session.url });
  } catch (error) {
    next(new Error("Failed to create payment session"));
  }
};

/**
 * Remaining balance checkout session (private event only).
 * Called from the user dashboard for bookings with paymentStatus === "deposit_paid".
 */
export const createRemainingCheckoutSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ success: false, code: "STRIPE_NOT_CONFIGURED", message: "Payments are not configured." });
      return;
    }

    const bookingId = String(req.body.bookingId || "").trim();
    if (!bookingId) {
      res.status(400).json({ success: false, message: "bookingId is required" });
      return;
    }

    const booking = await Booking.findById(bookingId).populate("tables");
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (booking.user.toString() !== req.user?._id.toString()) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    if (booking.remainingPaymentStatus === "paid") {
      res.status(400).json({ success: false, message: "Remaining balance is already paid" });
      return;
    }

    if (booking.paymentStatus !== "deposit_paid") {
      res.status(400).json({ success: false, message: "Deposit must be paid before paying balance" });
      return;
    }

    const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
    const chargeAmount = Math.max(50, Math.round(booking.remainingAmount * 100));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      billing_address_collection: "auto",
      customer_email: req.user?.email || booking.customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: {
              name: "Tropica Venue – Remaining Balance",
              description: `Remaining balance for Private Venue on ${booking.bookingDate.toLocaleDateString()} at ${booking.bookingTime}`
            },
            unit_amount: chargeAmount
          }
        }
      ],
      metadata: {
        bookingId: String(booking._id),
        userId: req.user!._id.toString(),
        isBalancePayment: "true"
      },
      payment_intent_data: {
        description: `Tropica Booking #${bookingId.slice(-6).toUpperCase()} – ${booking.customerName} – BALANCE`
      },
      success_url: `${baseUrl}/user/payment/confirmed?session_id={CHECKOUT_SESSION_ID}&bookingId=${booking.id}&type=balance`,
      cancel_url: `${baseUrl}/user/bookings?reason=balance_cancelled`
    });

    res.status(201).json({ success: true, url: session.url });
  } catch (error) {
    next(new Error("Failed to create balance payment session"));
  }
};

export const createPaymentIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ success: false, message: "Stripe not configured" });
      return;
    }

    const { bookingId } = req.body;
    if (!bookingId) {
      res.status(400).json({ success: false, message: "bookingId is required" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    // Create a PaymentIntent for the deposit amount
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.max(50, Math.round(booking.depositAmount * 100)),
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        bookingId: String(booking._id),
        customerName: booking.customerName,
        bookingType: booking.bookingType,
        isBalancePayment: "false"
      },
    });

    const secretKeyPrefix = (stripe as any)._api?.auth?.split(" ")[1]?.substring(0, 10);
    logger.info(`Creating PaymentIntent with key prefix: ${secretKeyPrefix}... and bookingId: ${bookingId}`);

    res.status(201).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error: any) {
    next(new Error(`Failed to create PaymentIntent: ${error.message}`));
  }
};

export const verifyCheckoutSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({
        success: false,
        code: "STRIPE_NOT_CONFIGURED",
        message: "Payments are not configured."
      });
      return;
    }

    const sessionId = String(req.body.sessionId || "").trim();
    if (!sessionId) {
      res.status(400).json({ success: false, message: "sessionId is required" });
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      res.status(400).json({ success: false, message: "Payment not completed" });
      return;
    }

    const bookingId = session.metadata?.bookingId;
    const isBalancePayment = session.metadata?.isBalancePayment === "true";

    if (!bookingId) {
      res.status(400).json({ success: false, message: "Missing booking on session" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (booking.user.toString() !== req.user?._id.toString()) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    if (isBalancePayment) {
      // Remaining balance paid
      booking.remainingPaymentStatus = "paid";
      booking.paymentStatus = "paid";
      await booking.save();
      logger.info(`Booking ${bookingId} – remaining balance marked as paid.`);
      void sendFullPaymentConfirmationViaEmailJS(booking);
    } else {
      // Deposit paid
      if (booking.paymentStatus === "pending_payment") {
        if (booking.remainingAmount === 0) {
          booking.paymentStatus = "paid";
          booking.remainingPaymentStatus = "paid";
          booking.status = "confirmed";
        } else {
          booking.paymentStatus = "deposit_paid";
          booking.status = "confirmed";
        }

        if (booking.couponUsed) {
          await Coupon.findByIdAndUpdate(booking.couponUsed, { $inc: { usageCount: 1 } }).catch(e => logger.error(`Failed to increment coupon ${booking.couponUsed}`, e));
        }

        await booking.save();
        logger.info(`Booking ${bookingId} – deposit marked as paid. Remaining: $${booking.remainingAmount}`);
        void sendPaymentEmails(booking);
      } else {
        // Idempotency: skip coupon increment if already paid.
        logger.info(`Booking ${bookingId} already marked as paid.`);
      }

      // ✅ Send EmailJS balance-due reminder if there's still a remaining amount
      if (booking.remainingAmount > 0) {
        const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
        const paymentLink = `${baseUrl}/user/venue-bookings`;
        console.log(`\n🟡 [EmailJS] Deposit confirmed for booking ${bookingId}`);
        console.log(`🟡 [EmailJS] Remaining balance: $${booking.remainingAmount} — sending reminder to ${booking.customerEmail}`);
        console.log(`🟡 [EmailJS] Payment link: ${paymentLink}`);
        void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
      } else {
        console.log(`\n🟡 [EmailJS] Deposit covers full amount for booking ${bookingId}`);
        void sendFullPaymentConfirmationViaEmailJS(booking);
      }
    }

    const updated = await Booking.findById(bookingId).populate("tables");
    res.status(200).json({ success: true, booking: updated });
  } catch (error) {
    next(new Error("Failed to verify payment"));
  }
};

export const verifyPaymentIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ success: false, code: "STRIPE_NOT_CONFIGURED", message: "Payments are not configured." });
      return;
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      res.status(400).json({ success: false, message: "paymentIntentId is required" });
      return;
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== "succeeded") {
      res.status(400).json({ success: false, message: "Payment intent not succeeded" });
      return;
    }

    const bookingId = paymentIntent.metadata?.bookingId;
    const isBalancePayment = paymentIntent.metadata?.isBalancePayment === "true";

    if (!bookingId) {
      res.status(400).json({ success: false, message: "Missing booking on payment intent" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    if (booking.paymentStatus === "paid" && (!isBalancePayment || booking.remainingPaymentStatus === "paid")) {
      // Already handled by webhook
      const updated = await Booking.findById(bookingId).populate("tables");
      res.status(200).json({ success: true, booking: updated });
      return;
    }

    if (isBalancePayment) {
      booking.remainingPaymentStatus = "paid";
      booking.paymentStatus = "paid";
      await booking.save();
      logger.info(`PaymentIntent Verification: Booking ${bookingId} remaining balance marked as paid.`);
      void sendFullPaymentConfirmationViaEmailJS(booking);
    } else {
      if (booking.paymentStatus === "pending_payment") {
        if (booking.remainingAmount === 0) {
          booking.paymentStatus = "paid";
          booking.remainingPaymentStatus = "paid";
          booking.status = "confirmed";
        } else {
          booking.paymentStatus = "deposit_paid";
          booking.status = "confirmed";
        }
        if (booking.couponUsed) {
          await Coupon.findByIdAndUpdate(booking.couponUsed, { $inc: { usageCount: 1 } });
        }
        await booking.save();
        logger.info(`PaymentIntent Verification: Booking ${bookingId} deposit marked as paid.`);
        void sendPaymentEmails(booking);
      }

      if (booking.remainingAmount > 0) {
        const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
        const paymentLink = `${baseUrl}/user/venue-bookings`;
        console.log(`\n🟡 [EmailJS] PaymentIntent verified for booking ${bookingId}`);
        console.log(`🟡 [EmailJS] Remaining balance: $${booking.remainingAmount} — sending reminder to ${booking.customerEmail}`);
        console.log(`🟡 [EmailJS] Payment link: ${paymentLink}`);
        void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
      } else {
        console.log(`\n🟡 [EmailJS] Deposit covers full amount for booking ${bookingId}`);
        void sendFullPaymentConfirmationViaEmailJS(booking);
      }
    }

    const updated = await Booking.findById(bookingId).populate("tables");
    res.status(200).json({ success: true, booking: updated });
  } catch (error) {
    next(new Error("Failed to verify payment intent"));
  }
};

export const handleStripeWebhook = async (req: Request, res: Response): Promise<void> => {
  logger.info(`Received webhook request to ${req.originalUrl}`);
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !sig || !endpointSecret) {
    res.status(400).send("Webhook Error: Missing configuration or signature");
    return;
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    logger.error("Webhook signature verification failed.", { error: err.message });
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as any;
      const bookingId = session.metadata?.bookingId;
      const isBalancePayment = session.metadata?.isBalancePayment === "true";

      if (bookingId) {
        try {
          const booking = await Booking.findById(bookingId);
          if (booking) {
            if (isBalancePayment && booking.remainingPaymentStatus !== "paid") {
              booking.remainingPaymentStatus = "paid";
              booking.paymentStatus = "paid";
              await booking.save();
              logger.info(`Webhook: Booking ${bookingId} balance marked as paid.`);
              void sendFullPaymentConfirmationViaEmailJS(booking);
            } else if (!isBalancePayment && booking.paymentStatus === "pending_payment") {
              if (booking.remainingAmount === 0) {
                booking.paymentStatus = "paid";
                booking.remainingPaymentStatus = "paid";
                booking.status = "confirmed";
              } else {
                booking.paymentStatus = "deposit_paid";
                booking.status = "confirmed";
              }
              if (booking.couponUsed) {
                await Coupon.findByIdAndUpdate(booking.couponUsed, { $inc: { usageCount: 1 } }).catch(e => logger.error(`Stripe Webhook: Failed to increment coupon`, e));
              }
              await booking.save();
              logger.info(`Webhook: Booking ${bookingId} deposit marked as paid.`);
              void sendPaymentEmails(booking);

              if (booking.remainingAmount > 0) {
                const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
                const paymentLink = `${baseUrl}/user/venue-bookings`;
                console.log(`\n🟡 [EmailJS] Stripe Webhook: Deposit confirmed for booking ${bookingId}`);
                console.log(`🟡 [EmailJS] Remaining balance: $${booking.remainingAmount} — sending reminder to ${booking.customerEmail}`);
                console.log(`🟡 [EmailJS] Payment link: ${paymentLink}`);
                void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
              } else {
                console.log(`\n🟡 [EmailJS] Deposit covers full amount for booking ${bookingId}`);
                void sendFullPaymentConfirmationViaEmailJS(booking);
              }
            }
          }
        } catch (dbErr: any) {
          logger.error(`Webhook: Failed to update booking ${bookingId}.`, { error: dbErr.message });
        }
      }
      break;
    }
    default:
      logger.debug(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
};

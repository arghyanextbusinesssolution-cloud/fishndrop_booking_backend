import type { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import Stripe from "stripe";
import { loadEnvFiles } from "../config/loadEnv";
import Booking from "../models/Booking";
import logger from "../config/logger";

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

export const createCheckoutSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      // eslint-disable-next-line no-console
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

    const booking = await Booking.findById(bookingId);
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
              name: "Fish & Drop Table Booking",
              description: `Reservation for ${booking.partySize} people on ${booking.bookingDate.toDateString()} at ${booking.bookingTime}`
            },
            unit_amount: Math.max(50, Math.round(booking.totalAmount * 100))
          }
        }
      ],
      metadata: {
        bookingId: String(booking._id),
        userId: req.user!._id.toString()
      },
      success_url: `${baseUrl}/user/payment/confirmed?session_id={CHECKOUT_SESSION_ID}&bookingId=${booking.id}`,
      cancel_url: `${baseUrl}/user/payment/failed?bookingId=${booking.id}&reason=cancelled`
    });

    res.status(201).json({ success: true, url: session.url });
  } catch (error) {
    next(new Error("Failed to create payment session"));
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
    if (!bookingId) {
      res.status(400).json({ success: false, message: "Missing booking on session" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    // Small fix: verifyCheckoutSession should probably allow unauthenticated checks if the session is valid,
    // but the current implementation requires req.user. We'll leave it for now as it matches existing logic.
    if (booking.user.toString() !== req.user?._id.toString()) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }

    booking.paymentStatus = "paid";
    await booking.save();

    const updated = await Booking.findById(bookingId).populate("tables");
    res.status(200).json({ success: true, booking: updated });
  } catch (error) {
    next(new Error("Failed to verify payment"));
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

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    logger.error("Webhook signature verification failed.", { error: err.message });
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as any;
      const bookingId = session.metadata?.bookingId;

      if (bookingId) {
        try {
          const booking = await Booking.findById(bookingId);
          if (booking && booking.paymentStatus !== "paid") {
            booking.paymentStatus = "paid";
            await booking.save();
            logger.info(`Booking ${bookingId} marked as paid via webhook.`);
          }
        } catch (dbErr: any) {
          logger.error(`Failed to update booking ${bookingId} via webhook.`, { error: dbErr.message });
        }
      }
      break;
    }
    default:
      logger.debug(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
};


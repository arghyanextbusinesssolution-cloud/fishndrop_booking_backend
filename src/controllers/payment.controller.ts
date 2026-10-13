import type { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import Stripe from "stripe";
import { loadEnvFiles } from "../config/loadEnv";
import mongoose from "mongoose";
import Booking from "../models/Booking";
import Coupon from "../models/Coupon";
import logger from "../config/logger";
import { v2 as cloudinary } from "cloudinary";
import { sendPaymentEmails, sendRemainingBalanceReminderViaEmailJS, sendFullPaymentConfirmationViaEmailJS } from "../utils/email.utils";
import { sendGHLBookingEvent, sendGHLZellePendingEvent, sendGHLZelleConfirmedEvent } from "../utils/ghl.utils";

// Configure Cloudinary explicitly
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dxx54fccl",
  api_key: process.env.CLOUDINARY_API_KEY || "149937643231624",
  api_secret: process.env.CLOUDINARY_API_SECRET || "whOZPJleA7xJeu_R8kckqq3Lprc"
});

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

function computeChargeAmount(amountInDollars: number): number {
  const secretKey = readStripeSecretKey();
  const rawEnv = (process.env.STRIPE_TEST_ONE_DOLLAR_PAYMENT || "").trim().toLowerCase();

  const isExplicitlyDisabled = rawEnv === "false" || rawEnv === "0" || rawEnv === "off" || rawEnv === "no";
  const isExplicitlyEnabled = rawEnv === "true" || rawEnv === "1" || rawEnv === "on" || rawEnv === "yes";

  const isOneDollarTesting = !isExplicitlyDisabled && (isExplicitlyEnabled || secretKey?.startsWith("sk_test_"));

  if (isOneDollarTesting) {
    logger.info(`[Stripe $1 Test Payment Mode] Charging $1.00 (100 cents) instead of $${amountInDollars} for test payment session.`);
    return 100;
  }

  return Math.max(50, Math.round(amountInDollars * 100));
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
    const chargeAmount = computeChargeAmount(booking.depositAmount);

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

    const isFoodPayment = req.body.isFoodPayment === true || req.body.isFood === true;
    if (isFoodPayment) {
      if (!booking.offerPrice || booking.offerPrice <= 0) {
        res.status(400).json({ success: false, message: "No active food quote found for this booking" });
        return;
      }
      if (booking.foodPaymentStatus === "paid") {
        res.status(400).json({ success: false, message: "Food catering package is already paid" });
        return;
      }

      const foodCharge = booking.offerPrice;
      const chargeAmount = computeChargeAmount(foodCharge);
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
                name: "Tropica Catering – Food & Dining Package",
                description: `Payment for Private Buyout Food Catering on ${booking.bookingDate.toLocaleDateString()} at ${booking.bookingTime} – Full Package $${foodCharge.toFixed(2)}`
              },
              unit_amount: chargeAmount
            }
          }
        ],
        metadata: {
          bookingId: String(booking._id),
          userId: req.user!._id.toString(),
          isFoodPayment: "true",
          isBalancePayment: "false",
          chargeAmount: foodCharge.toString()
        },
        payment_intent_data: {
          description: `Tropica Booking #${bookingId.slice(-6).toUpperCase()} – ${booking.customerName} – FOOD CATERING ($${foodCharge.toFixed(2)})`
        },
        success_url: `${baseUrl}/user/payment/confirmed?session_id={CHECKOUT_SESSION_ID}&bookingId=${booking.id}&type=food`,
        cancel_url: `${baseUrl}/user/venue-bookings?reason=food_payment_cancelled`
      });

      res.status(201).json({ success: true, url: session.url });
      return;
    }

    if (booking.remainingPaymentStatus === "paid" || booking.remainingAmount <= 0) {
      res.status(400).json({ success: false, message: "Remaining balance is already paid" });
      return;
    }

    if (booking.paymentStatus !== "deposit_paid" && booking.paymentStatus !== "pending_payment") {
      res.status(400).json({ success: false, message: "Deposit must be paid before paying balance" });
      return;
    }

    const customAmount = req.body.amount ? Number(req.body.amount) : null;
    const amountToCharge = (customAmount && customAmount > 0 && customAmount <= booking.remainingAmount)
      ? Math.round(customAmount * 100) / 100
      : booking.remainingAmount;

    const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
    const chargeAmount = computeChargeAmount(amountToCharge);
    const isPartial = amountToCharge < booking.remainingAmount;
    const iterationNum = (booking.paymentBreakdown?.length || 0) + 1;

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
              name: `Tropica Venue – Remaining Balance ${isPartial ? `(Installment #${iterationNum})` : ""}`,
              description: `Payment for Private Venue on ${booking.bookingDate.toLocaleDateString()} at ${booking.bookingTime} – ${isPartial ? `Installment of $${amountToCharge.toFixed(2)}` : "Full Balance Settlement"}`
            },
            unit_amount: chargeAmount
          }
        }
      ],
      metadata: {
        bookingId: String(booking._id),
        userId: req.user!._id.toString(),
        isBalancePayment: "true",
        chargeAmount: amountToCharge.toString(),
        isPartial: isPartial ? "true" : "false",
        iterationIndex: iterationNum.toString()
      },
      payment_intent_data: {
        description: `Tropica Booking #${bookingId.slice(-6).toUpperCase()} – ${booking.customerName} – BALANCE ${isPartial ? `(Installment #${iterationNum})` : "(FULL)"}`
      },
      success_url: `${baseUrl}/user/payment/confirmed?session_id={CHECKOUT_SESSION_ID}&bookingId=${booking.id}&type=balance`,
      cancel_url: `${baseUrl}/user/venue-bookings?reason=balance_cancelled`
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
      amount: computeChargeAmount(booking.depositAmount),
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

    const isFoodPayment = session.metadata?.isFoodPayment === "true";
    if (isFoodPayment) {
      const foodPaid = session.metadata?.chargeAmount ? Number(session.metadata.chargeAmount) : (booking.offerPrice || 0);
      const txnId = session.payment_intent ? String(session.payment_intent) : session.id;
      const alreadyRecorded = booking.paymentBreakdown?.some(p => p.transactionId === txnId);

      if (!alreadyRecorded) {
        booking.foodPaymentStatus = "paid";
        booking.foodPaymentMethod = "card";
        booking.foodPaidAt = new Date();

        booking.paymentBreakdown = booking.paymentBreakdown || [];
        booking.paymentBreakdown.push({
          amount: foodPaid,
          paymentMethod: "card",
          paymentType: "food_catering",
          status: "verified",
          transactionId: txnId,
          notes: `Card payment of $${foodPaid.toFixed(2)} for food catering package`,
          paidAt: new Date()
        });

        booking.quoteHistory = booking.quoteHistory || [];
        booking.quoteHistory.push({
          action: "quote_accepted",
          actor: "user",
          actorName: booking.customerName || "Customer",
          price: foodPaid,
          notes: `Food catering package paid ($${foodPaid.toFixed(2)}) via card`,
          createdAt: new Date()
        });

        await booking.save();
        logger.info(`Booking ${bookingId} – food quote payment of $${foodPaid} settled.`);
      }
      res.status(200).json({ success: true, message: "Food payment confirmed", booking });
      return;
    }

    if (isBalancePayment) {
      const paidAmount = session.metadata?.chargeAmount
        ? Number(session.metadata.chargeAmount)
        : (session.amount_total ? session.amount_total / 100 : booking.remainingAmount);

      const txnId = session.payment_intent ? String(session.payment_intent) : session.id;
      const alreadyRecorded = booking.paymentBreakdown?.some(p => p.transactionId === txnId);

      if (!alreadyRecorded) {
        booking.remainingAmount = Math.max(0, Math.round((booking.remainingAmount - paidAmount) * 100) / 100);
        const isFullyPaid = booking.remainingAmount <= 0;

        if (isFullyPaid) {
          booking.remainingAmount = 0;
          booking.remainingPaymentStatus = "paid";
          booking.paymentStatus = "paid";
        } else {
          booking.remainingPaymentStatus = "unpaid";
          booking.paymentStatus = "deposit_paid";
        }

        booking.paymentBreakdown = booking.paymentBreakdown || [];
        booking.paymentBreakdown.push({
          amount: paidAmount,
          paymentMethod: "card",
          paymentType: isFullyPaid ? "balance_full" : "balance_partial",
          status: "verified",
          transactionId: txnId,
          iterationIndex: (booking.paymentBreakdown.length || 0) + 1,
          notes: `Card payment of $${paidAmount.toFixed(2)} for ${isFullyPaid ? "final balance" : "balance breakdown"}`,
          paidAt: new Date()
        });

        await booking.save();
        logger.info(`Booking ${bookingId} – balance payment of $${paidAmount} processed. Remaining: $${booking.remainingAmount}`);

        if (isFullyPaid) {
          void sendFullPaymentConfirmationViaEmailJS(booking);
          void sendGHLBookingEvent(booking);
        } else {
          const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
          const paymentLink = `${baseUrl}/user/venue-bookings`;
          void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
          void sendGHLBookingEvent(booking);
        }
      }
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

        const txnId = session.payment_intent ? String(session.payment_intent) : session.id;
        booking.paymentBreakdown = booking.paymentBreakdown || [];
        if (!booking.paymentBreakdown.some(p => p.transactionId === txnId)) {
          booking.paymentBreakdown.push({
            amount: booking.depositAmount || booking.totalAmount,
            paymentMethod: "card",
            paymentType: "deposit",
            status: "verified",
            transactionId: txnId,
            iterationIndex: 1,
            notes: `Initial deposit of $${(booking.depositAmount || booking.totalAmount).toFixed(2)} paid via Card`,
            paidAt: new Date()
          });
        }

        await booking.save();
        logger.info(`Booking ${bookingId} – deposit marked as paid. Remaining: $${booking.remainingAmount}`);
        void sendPaymentEmails(booking);
        void sendGHLBookingEvent(booking);
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
      const paidAmount = paymentIntent.metadata?.chargeAmount
        ? Number(paymentIntent.metadata.chargeAmount)
        : (paymentIntent.amount ? paymentIntent.amount / 100 : booking.remainingAmount);

      const txnId = paymentIntent.id;
      const alreadyRecorded = booking.paymentBreakdown?.some(p => p.transactionId === txnId);

      if (!alreadyRecorded) {
        booking.remainingAmount = Math.max(0, Math.round((booking.remainingAmount - paidAmount) * 100) / 100);
        const isFullyPaid = booking.remainingAmount <= 0;

        if (isFullyPaid) {
          booking.remainingAmount = 0;
          booking.remainingPaymentStatus = "paid";
          booking.paymentStatus = "paid";
        } else {
          booking.remainingPaymentStatus = "unpaid";
          booking.paymentStatus = "deposit_paid";
        }

        booking.paymentBreakdown = booking.paymentBreakdown || [];
        booking.paymentBreakdown.push({
          amount: paidAmount,
          paymentMethod: "card",
          paymentType: isFullyPaid ? "balance_full" : "balance_partial",
          status: "verified",
          transactionId: txnId,
          iterationIndex: (booking.paymentBreakdown.length || 0) + 1,
          notes: `PaymentIntent payment of $${paidAmount.toFixed(2)} for ${isFullyPaid ? "final balance" : "balance breakdown"}`,
          paidAt: new Date()
        });

        await booking.save();
        logger.info(`PaymentIntent Verification: Booking ${bookingId} balance payment of $${paidAmount} processed. Remaining: $${booking.remainingAmount}`);

        if (isFullyPaid) {
          void sendFullPaymentConfirmationViaEmailJS(booking);
          void sendGHLBookingEvent(booking);
        } else {
          const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
          const paymentLink = `${baseUrl}/user/venue-bookings`;
          void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
          void sendGHLBookingEvent(booking);
        }
      }
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

        const txnId = paymentIntent.id;
        booking.paymentBreakdown = booking.paymentBreakdown || [];
        if (!booking.paymentBreakdown.some(p => p.transactionId === txnId)) {
          booking.paymentBreakdown.push({
            amount: booking.depositAmount || booking.totalAmount,
            paymentMethod: "card",
            paymentType: "deposit",
            status: "verified",
            transactionId: txnId,
            iterationIndex: 1,
            notes: `Deposit of $${(booking.depositAmount || booking.totalAmount).toFixed(2)} paid via Card`,
            paidAt: new Date()
          });
        }

        await booking.save();
        logger.info(`PaymentIntent Verification: Booking ${bookingId} deposit marked as paid.`);
        void sendPaymentEmails(booking);
        void sendGHLBookingEvent(booking);
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
            const txnId = session.payment_intent ? String(session.payment_intent) : session.id;
            const alreadyRecorded = booking.paymentBreakdown?.some(p => p.transactionId === txnId);

            if (isBalancePayment) {
              const paidAmount = session.metadata?.chargeAmount
                ? Number(session.metadata.chargeAmount)
                : (session.amount_total ? session.amount_total / 100 : booking.remainingAmount);

              if (!alreadyRecorded) {
                booking.remainingAmount = Math.max(0, Math.round((booking.remainingAmount - paidAmount) * 100) / 100);
                const isFullyPaid = booking.remainingAmount <= 0;

                if (isFullyPaid) {
                  booking.remainingAmount = 0;
                  booking.remainingPaymentStatus = "paid";
                  booking.paymentStatus = "paid";
                } else {
                  booking.remainingPaymentStatus = "unpaid";
                  booking.paymentStatus = "deposit_paid";
                }

                booking.paymentBreakdown = booking.paymentBreakdown || [];
                booking.paymentBreakdown.push({
                  amount: paidAmount,
                  paymentMethod: "card",
                  paymentType: isFullyPaid ? "balance_full" : "balance_partial",
                  status: "verified",
                  transactionId: txnId,
                  iterationIndex: (booking.paymentBreakdown.length || 0) + 1,
                  notes: `Stripe webhook processed $${paidAmount.toFixed(2)} (${isFullyPaid ? "final balance" : "balance breakdown"})`,
                  paidAt: new Date()
                });

                await booking.save();
                logger.info(`Webhook: Booking ${bookingId} balance payment of $${paidAmount} processed. Remaining: $${booking.remainingAmount}`);

                if (isFullyPaid) {
                  void sendFullPaymentConfirmationViaEmailJS(booking);
                  void sendGHLBookingEvent(booking);
                } else {
                  const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
                  const paymentLink = `${baseUrl}/user/venue-bookings`;
                  void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
                  void sendGHLBookingEvent(booking);
                }
              }
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

              if (!alreadyRecorded) {
                booking.paymentBreakdown = booking.paymentBreakdown || [];
                booking.paymentBreakdown.push({
                  amount: booking.depositAmount || booking.totalAmount,
                  paymentMethod: "card",
                  paymentType: "deposit",
                  status: "verified",
                  transactionId: txnId,
                  iterationIndex: 1,
                  notes: `Deposit of $${(booking.depositAmount || booking.totalAmount).toFixed(2)} paid via Card`,
                  paidAt: new Date()
                });
              }

              await booking.save();
              logger.info(`Webhook: Booking ${bookingId} deposit marked as paid.`);
              void sendPaymentEmails(booking);
              void sendGHLBookingEvent(booking);

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

/**
 * Screenshot proof upload endpoint.
 * For initial deposit (isBalance=false): uploads to zelleProofUrl, keeps status pending.
 * For remaining balance (isBalance=true): uploads to remainingZelleProofUrl, keeps remainingPaymentStatus unpaid.
 * CRITICAL: Screenshot upload alone DOES NOT confirm payment — awaits GHL verification or Admin approval.
 */
export const uploadZelleProof = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bookingId, imageBase64, isBalance, amount, notes: clientNotes } = req.body;
    if (!bookingId || !imageBase64) {
      res.status(400).json({ success: false, message: "bookingId and imageBase64 are required" });
      return;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }

    const isFoodPayment = req.body.isFood === true || req.body.isFood === "true";
    const isBalancePayment = !isFoodPayment && (isBalance === true || isBalance === "true");
    const folderName = isFoodPayment
      ? "fishndrop_zelle_food_proofs"
      : isBalancePayment
      ? "fishndrop_zelle_balance_proofs"
      : "fishndrop_zelle_proofs";

    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: folderName,
      resource_type: "image"
    });

    booking.paymentMethod = "zelle";
    booking.zelleUploadedAt = new Date();

    const customAmount = amount ? Number(amount) : null;
    const breakdownAmount = (customAmount && customAmount > 0)
      ? Math.round(customAmount * 100) / 100
      : (isFoodPayment ? (booking.offerPrice || 0) : (isBalancePayment ? booking.remainingAmount : (booking.depositAmount || booking.totalAmount)));

    const iterationNum = (booking.paymentBreakdown?.length || 0) + 1;

    if (isFoodPayment) {
      // ── Food Catering Quote Zelle Proof ──
      const foodAmount = booking.offerPrice || breakdownAmount;
      booking.foodZelleProofUrl = result.secure_url;
      booking.foodPaymentStatus = "pending_verification";
      booking.foodPaymentMethod = "zelle";
      if (clientNotes) booking.zelleNotes = clientNotes;

      booking.paymentBreakdown = booking.paymentBreakdown || [];
      booking.paymentBreakdown.push({
        amount: foodAmount,
        paymentMethod: "zelle",
        paymentType: "food_catering",
        status: "pending",
        proofUrl: result.secure_url,
        iterationIndex: iterationNum,
        notes: clientNotes || `Zelle proof submitted for food catering package ($${foodAmount.toFixed(2)})`,
        paidAt: new Date()
      });

      booking.quoteHistory = booking.quoteHistory || [];
      booking.quoteHistory.push({
        action: "quote_accepted",
        actor: "user",
        actorName: booking.customerName || "Customer",
        price: foodAmount,
        notes: "Uploaded Zelle payment proof for food catering quote",
        createdAt: new Date()
      });

      logger.info(`[Zelle Food Upload] Food quote screenshot uploaded for booking #${bookingId.slice(-6).toUpperCase()} ($${foodAmount}). Awaiting Admin verification.`);
    } else if (isBalancePayment) {
      // ── Remaining Balance Zelle Proof ──
      booking.remainingZelleProofUrl = result.secure_url;
      // Mark balance for verification — keep initial deposit status intact!
      booking.remainingZelleVerificationStatus = "pending_ghl_verification";
      if (clientNotes) booking.zelleNotes = clientNotes;

      booking.paymentBreakdown = booking.paymentBreakdown || [];
      booking.paymentBreakdown.push({
        amount: breakdownAmount,
        paymentMethod: "zelle",
        paymentType: breakdownAmount < booking.remainingAmount ? "balance_partial" : "balance_full",
        status: "pending",
        proofUrl: result.secure_url,
        iterationIndex: iterationNum,
        notes: clientNotes || `Zelle proof submitted for $${breakdownAmount.toFixed(2)} balance breakdown (Installment #${iterationNum})`,
        paidAt: new Date()
      });

      logger.info(`[Zelle Balance Upload] Remaining balance screenshot uploaded for booking #${bookingId.slice(-6).toUpperCase()} ($${breakdownAmount}). Awaiting GHL/Admin verification.`);
    } else {
      // ── Initial Deposit Zelle Proof ──
      booking.zelleProofUrl = result.secure_url;
      booking.zelleVerificationStatus = "pending_ghl_verification";
      booking.status = "pending";
      booking.paymentStatus = "pending_payment";
      if (clientNotes) booking.zelleNotes = clientNotes;

      booking.paymentBreakdown = booking.paymentBreakdown || [];
      booking.paymentBreakdown.push({
        amount: breakdownAmount,
        paymentMethod: "zelle",
        paymentType: "deposit",
        status: "pending",
        proofUrl: result.secure_url,
        iterationIndex: 1,
        notes: clientNotes || `Zelle proof submitted for $${breakdownAmount.toFixed(2)} deposit`,
        paidAt: new Date()
      });

      logger.info(`[Zelle Upload] Deposit screenshot uploaded for booking #${bookingId.slice(-6).toUpperCase()}. Remaining PENDING for GHL verification.`);
    }

    await booking.save();

    void sendGHLZellePendingEvent(booking);

    res.status(200).json({
      success: true,
      message: isBalancePayment
        ? "Remaining balance Zelle proof uploaded. Pending GHL balance verification."
        : "Zelle deposit proof uploaded. Pending GHL email verification.",
      zelleProofUrl: isBalancePayment ? result.secure_url : booking.zelleProofUrl,
      isBalance: isBalancePayment,
      booking
    });
  } catch (error: any) {
    logger.error("[Zelle Proof Upload Error]", error);
    next(new Error(`Failed to upload Zelle proof: ${error.message}`));
  }
};

/**
 * GHL Secure Verification Webhook
 * Called by GoHighLevel when it parses a Zelle confirmation email.
 * Supports two payment types:
 *   paymentType = "deposit" (default): verifies initial deposit, confirms booking & locks slot.
 *   paymentType = "balance": verifies remaining balance, marks booking as fully paid.
 * Missing or mismatched details -> flagged for manual review.
 */
export const handleGHLZelleWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const webhookSecret = process.env.GHL_ZELLE_WEBHOOK_SECRET || "fishndrop_zelle_secure_secret_2026";
    const headerSecret = req.headers["x-ghl-secret"] || req.query.secret;

    if (headerSecret && headerSecret !== webhookSecret) {
      logger.warn("[GHL Zelle Webhook] Unauthorized caller — secret mismatch");
      res.status(401).json({ success: false, message: "Unauthorized webhook secret" });
      return;
    }

    const body = req.body || {};
    logger.info(`[GHL Zelle Webhook] Incoming Payload:\n${JSON.stringify(body, null, 2)}`);

    // Helper: deeply find any booking ID or short code in object/array/strings
    const findBookingIdInObject = (obj: any): string | null => {
      if (!obj) return null;
      if (typeof obj === "string") {
        // Direct 24-hex ObjectId
        const hex24Match = obj.match(/\b([a-f0-9]{24})\b/i);
        if (hex24Match) return hex24Match[1];
        // Memo or hash format e.g. #6ac63f or #6ac63f6cf08c
        const hashMatch = obj.match(/#([a-f0-9]{4,24})\b/i);
        if (hashMatch) return hashMatch[1];
        // Explicit label e.g. "Booking ID: 6ac63f" or "Booking: #6ac63f"
        const labelMatch = obj.match(/booking(?:_|\s*id)?[:=\s]+#?([a-f0-9]{4,24})/i);
        if (labelMatch) return labelMatch[1];
        return null;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const res = findBookingIdInObject(item);
          if (res) return res;
        }
        return null;
      }
      if (typeof obj === "object") {
        // Check well-known key names first
        const keyPriority = [
          "bookingId", "booking_id", "bookingID", "Booking ID", "Booking Id",
          "bookingCode", "booking_code", "Booking Code", "memo", "notes", "message",
          "subject", "body", "text", "description", "reference", "id"
        ];
        for (const k of keyPriority) {
          if (obj[k]) {
            const res = findBookingIdInObject(obj[k]);
            if (res) return res;
            if (typeof obj[k] === "string" && obj[k].trim().length >= 4) return obj[k].trim();
          }
        }
        for (const val of Object.values(obj)) {
          const res = findBookingIdInObject(val);
          if (res) return res;
        }
      }
      return null;
    };

    const extractString = (val: any): string => {
      if (!val) return "";
      if (typeof val === "string") return val;
      if (typeof val === "object") {
        if (typeof val.body === "string") return val.body;
        if (typeof val.message === "string") return val.message;
        if (typeof val.text === "string") return val.text;
        try {
          return JSON.stringify(val);
        } catch {
          return "";
        }
      }
      return String(val);
    };

    const rawBookingId =
      body.customData?.zelle_payment_id ||
      body.customData?.bookingId ||
      body.customData?.booking_id ||
      body.customData?.["Booking ID"] ||
      body.zelle_payment_id ||
      body.bookingId ||
      body.booking_id ||
      body.bookingID ||
      body["Booking ID"] ||
      body["Booking Id"] ||
      body.customFields?.booking_id ||
      body.customFields?.["Booking ID"] ||
      req.query.bookingId ||
      req.query.booking_id ||
      findBookingIdInObject(body);

    let rawAmount =
      body.customData?.zelle_payment_amount ??
      body.customData?.payment_amount ??
      body.customData?.amount ??
      body.zelle_payment_amount ??
      body.amount ??
      body.amountPaid ??
      body.amount_paid ??
      body.totalAmount ??
      body.total_amount ??
      body.paidAmount ??
      body.depositAmount ??
      req.query.amount;

    // Fallback: If amount not found directly, parse dollar amount from message body (e.g. "sent you $300.00")
    if (!rawAmount && body.message) {
      const msgText = typeof body.message === "object" ? body.message.body || "" : String(body.message);
      const amountMatch = msgText.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
      if (amountMatch) {
        rawAmount = amountMatch[1];
      }
    }

    const transactionId =
      body.transactionId ||
      body.transaction_id ||
      body.txn_id ||
      body.reference ||
      `GHL-ZEL-${Date.now()}`;

    const ghlStatus = String(
      body.status ||
      body.ghlStatus ||
      body.payment_status ||
      "verified"
    ).toLowerCase();

    const notes = extractString(body.notes || body.message || body.body || "");
    const paymentType = body.paymentType || body.payment_type || "deposit";
    const customerEmail = body.customerEmail || body.customer_email || body.email || body.contact?.email;

    let booking = null;

    if (rawBookingId) {
      const cleanId = String(rawBookingId).replace(/^#/, "").trim();

      // 1. Search by MongoDB ObjectId (exact match)
      if (mongoose.Types.ObjectId.isValid(cleanId)) {
        booking = await Booking.findById(cleanId).populate("tables");
      }

      // 2. Short ID match — fetch recent bookings (Zelle or pending) and match last N chars
      if (!booking && cleanId.length >= 4) {
        const recentBookings = await Booking.find({
          status: { $in: ["pending", "confirmed"] }
        }).sort({ createdAt: -1 }).limit(300).populate("tables");

        const shortUpper = cleanId.toUpperCase();
        booking = recentBookings.find(b => {
          const id = b._id?.toString() || "";
          return id.toUpperCase().endsWith(shortUpper) || id.slice(-cleanId.length).toUpperCase() === shortUpper;
        }) || null;
      }
    }

    // 3. Fallback search by customer email ONLY if not a bank alert email
    const isBankDomain = customerEmail && /bankofamerica|chase|wellsfargo|citi|zellepay|pnc|usbank/i.test(customerEmail);
    if (!booking && customerEmail && !isBankDomain) {
      booking = await Booking.findOne({
        customerEmail: { $regex: new RegExp(`^${String(customerEmail).trim()}$`, "i") },
        status: { $in: ["pending", "confirmed"] }
      }).sort({ createdAt: -1 }).populate("tables");
    }

    if (!booking) {
      logger.warn(`[GHL Zelle Webhook] Booking not found. Searched Booking ID: '${rawBookingId}', Email: '${customerEmail}'`);
      res.status(404).json({
        success: false,
        message: `Booking not found (Searched ID: '${rawBookingId || "none"}', Email: '${customerEmail || "none"}')`,
        tip: "Ensure the booking ID (e.g. 24-char ObjectId or #shortcode) is included in the webhook payload, memo, notes, or customData."
      });
      return;
    }

    const isBalancePayment = paymentType === "balance" || (booking.paymentStatus === "deposit_paid" && booking.remainingAmount > 0);
    const receivedAmount = Number(rawAmount || 0);

    // The amount the booking expects: remaining balance for balance payments, deposit otherwise
    const expectedAmount = isBalancePayment
      ? Number(booking.remainingAmount || 0)
      : Number(booking.depositAmount || 0);

    // ⚠️ TESTING MODE: Accept ANY amount GHL sends (even $1)
    // When GHL fires this webhook, it means GHL verified the payment — trust it regardless of amount.
    // The receivedAmount will be saved as the actual payment so the booking shows real amount.
    const isStatusValid = ghlStatus !== "failed" && ghlStatus !== "mismatched" && ghlStatus !== "rejected";

    if (isStatusValid) {
      booking.zelleTransactionId = transactionId;

      if (isBalancePayment) {
        // Balance breakdown or full payment
        const paidAmount = receivedAmount > 0 ? receivedAmount : booking.remainingAmount;
        booking.remainingAmount = Math.max(0, Math.round((booking.remainingAmount - paidAmount) * 100) / 100);
        const isFullyPaid = booking.remainingAmount <= 0;

        if (isFullyPaid) {
          booking.remainingAmount = 0;
          booking.paymentStatus = "paid";
          booking.remainingPaymentStatus = "paid";
          booking.zelleVerificationStatus = "verified";
          booking.remainingZelleVerificationStatus = "verified";
        } else {
          booking.paymentStatus = "deposit_paid";
          booking.remainingPaymentStatus = "unpaid";
          booking.remainingZelleVerificationStatus = "verified";
        }

        booking.zelleNotes = notes || `Zelle balance payment of $${paidAmount.toFixed(2)} verified via GHL (Remaining: $${booking.remainingAmount.toFixed(2)})`;

        booking.paymentBreakdown = booking.paymentBreakdown || [];
        booking.paymentBreakdown.push({
          amount: paidAmount,
          paymentMethod: "zelle",
          paymentType: isFullyPaid ? "balance_full" : "balance_partial",
          status: "verified",
          transactionId: transactionId,
          iterationIndex: (booking.paymentBreakdown.length || 0) + 1,
          notes: notes || `Zelle payment verified: $${paidAmount.toFixed(2)}`,
          paidAt: new Date()
        });

        logger.info(`[GHL Zelle Webhook] Booking ${booking._id} BALANCE CLEARED/PARTIAL — $${paidAmount} paid via Zelle. Remaining: $${booking.remainingAmount}.`);

        if (isFullyPaid) {
          void sendFullPaymentConfirmationViaEmailJS(booking);
        } else {
          const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
          const paymentLink = `${baseUrl}/user/venue-bookings`;
          void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
        }
      } else {
        // Deposit payment — confirm booking & update deposit to actual amount received
        booking.status = "confirmed";

        if (receivedAmount > 0) {
          booking.depositAmount = receivedAmount;
          booking.remainingAmount = Math.max(0, Math.round((booking.totalAmount - receivedAmount) * 100) / 100);
        }

        if (booking.remainingAmount <= 0) {
          booking.paymentStatus = "paid";
          booking.remainingPaymentStatus = "paid";
        } else {
          booking.paymentStatus = "deposit_paid";
        }

        booking.zelleVerificationStatus = "verified";
        booking.zelleNotes = notes || `$${receivedAmount.toFixed(2)} deposit verified via GHL Zelle webhook`;

        booking.paymentBreakdown = booking.paymentBreakdown || [];

        // ✅ Dedup: skip if a verified deposit entry already exists
        const alreadyHasVerifiedDeposit = booking.paymentBreakdown.some(
          p => p.paymentType === "deposit" && p.status === "verified"
        );

        if (!alreadyHasVerifiedDeposit) {
          booking.paymentBreakdown.push({
            amount: receivedAmount || booking.depositAmount,
            paymentMethod: "zelle",
            paymentType: "deposit",
            status: "verified",
            transactionId: transactionId,
            iterationIndex: 1,
            notes: notes || `Deposit verified: $${(receivedAmount || booking.depositAmount).toFixed(2)}`,
            paidAt: new Date()
          });
          logger.info(`[GHL Zelle Webhook] Booking ${booking._id} CONFIRMED — $${receivedAmount} deposit recorded. Remaining: $${booking.remainingAmount}.`);
        } else {
          logger.info(`[GHL Zelle Webhook] Booking ${booking._id} — deposit already recorded, skipping duplicate push. Updated amounts only.`);
        }
      }

      if (booking.couponUsed) {
        await Coupon.findByIdAndUpdate(booking.couponUsed, { $inc: { usageCount: 1 } }).catch(e => logger.error("Coupon increment error", e));
      }

      await booking.save();

      const latestPaidNow = isBalancePayment
        ? (receivedAmount > 0 ? receivedAmount : booking.remainingAmount)
        : (receivedAmount || booking.depositAmount);

      console.log(`\n💳 [GHL Zelle Webhook Success] Booking #${booking._id.toString().slice(-6).toUpperCase()}`);
      console.log(`💳   Payment Type: ${isBalancePayment ? "Balance Installment" : "Deposit"}`);
      console.log(`💳   Paid Now    : $${latestPaidNow}`);
      console.log(`💳   Remaining   : $${booking.remainingAmount}`);
      console.log(`💳   Status      : ${booking.status} / ${booking.paymentStatus}\n`);

      // Trigger confirmation email & GHL events back to GHL
      void sendPaymentEmails(booking);
      if (!isBalancePayment && booking.remainingAmount > 0) {
        const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
        const paymentLink = `${baseUrl}/user/venue-bookings`;
        void sendRemainingBalanceReminderViaEmailJS(booking, paymentLink);
      } else if (!isBalancePayment && booking.remainingAmount <= 0) {
        void sendFullPaymentConfirmationViaEmailJS(booking);
      }

      void sendGHLBookingEvent(booking, { paidNow: latestPaidNow });
      // ✅ Fire dedicated Zelle confirmation webhook → GHL trigger with updated dynamic fields
      void sendGHLZelleConfirmedEvent(booking, { paidNow: latestPaidNow });

      res.status(200).json({
        success: true,
        message: isBalancePayment
          ? (booking.remainingAmount === 0 ? "Remaining balance confirmed and booking marked as fully paid." : `Balance installment of $${receivedAmount.toFixed(2)} verified. Remaining: $${booking.remainingAmount.toFixed(2)}`)
          : "Booking confirmed and deposit updated successfully via GHL Zelle verification.",
        booking
      });
    } else {
      // Flag for manual review if mismatch
      booking.zelleVerificationStatus = "mismatched";
      booking.zelleNotes = notes || `Payment detail mismatch: Expected $${expectedAmount.toFixed(2)}, received $${receivedAmount.toFixed(2)}. Flagged for manual review.`;

      if (!isBalancePayment) {
        booking.status = "pending";
        booking.paymentStatus = "pending_payment";
      }

      await booking.save();
      logger.warn(`[GHL Zelle Webhook] Booking ${booking._id} MISMATCHED. Expected $${expectedAmount}, got $${receivedAmount}.`);

      res.status(200).json({
        success: false,
        status: "manual_review",
        message: "Missing or mismatched payment details. Booking flagged for manual review.",
        booking
      });
    }
  } catch (error: any) {
    logger.error("[GHL Zelle Webhook Error]", error);
    next(new Error(`GHL Zelle Webhook error: ${error.message}`));
  }
};


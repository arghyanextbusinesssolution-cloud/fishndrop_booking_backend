import express from "express";
import {
  createCheckoutSession,
  createPaymentIntent,
  createRemainingCheckoutSession,
  handleStripeWebhook,
  verifyCheckoutSession,
  verifyPaymentIntent,
  uploadZelleProof,
  handleGHLZelleWebhook,
  createTourCheckoutSession,
  createTourPaymentIntent,
  getTourCheckouts
} from "../controllers/payment.controller";
import {
  createConnectAccount,
  getConnectOnboardingLink,
  getConnectAccountStatus,
  getConnectDashboardLink,
  simulateTestOnboarding
} from "../controllers/stripeConnect.controller";
import authMiddleware from "../middleware/auth.middleware";
import { promoterOnly } from "../middleware/promoter.middleware";

const router = express.Router();

// Webhook must be public and handle raw body for signature verification
router.post("/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

// GHL Secure Zelle verification webhook (Public, validated by secret key/header)
router.post("/ghl-zelle-webhook", express.json(), handleGHLZelleWebhook);
router.post("/zelle-webhook", express.json(), handleGHLZelleWebhook);
router.post("/zelle/webhook", express.json(), handleGHLZelleWebhook);

// Zelle proof upload
router.post("/upload-zelle-proof", express.json({ limit: "15mb" }), uploadZelleProof);

// Tour booking — public (no auth required, $25 flat fee)
router.post("/tour-checkout-session", express.json(), createTourCheckoutSession);
router.post("/tour-payment-intent", express.json(), createTourPaymentIntent);

// Admin: view all tour checkout bookings (admin auth required)
router.get("/tour-checkouts", express.json(), authMiddleware, getTourCheckouts);

// Stripe Connect for Promoters
router.post("/connect/create-account", express.json(), authMiddleware, promoterOnly, createConnectAccount);
router.post("/connect/onboarding-link", express.json(), authMiddleware, promoterOnly, getConnectOnboardingLink);
router.get("/connect/status", express.json(), authMiddleware, promoterOnly, getConnectAccountStatus);
router.post("/connect/dashboard-link", express.json(), authMiddleware, promoterOnly, getConnectDashboardLink);
router.post("/connect/simulate-onboarding", express.json(), authMiddleware, promoterOnly, simulateTestOnboarding);

// Protected routes - need express.json() manually because they are mounted before the global parser in index.ts
router.post("/checkout-session", express.json(), authMiddleware, createCheckoutSession);
router.post("/checkout-balance", express.json(), authMiddleware, createRemainingCheckoutSession);
router.post("/create-payment-intent", express.json(), authMiddleware, createPaymentIntent);
router.post("/verify-session", express.json(), authMiddleware, verifyCheckoutSession);
router.post("/verify-payment-intent", express.json(), authMiddleware, verifyPaymentIntent);

export default router;

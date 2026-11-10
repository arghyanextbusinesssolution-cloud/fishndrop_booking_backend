import { NextFunction, Request, Response } from "express";
import User from "../models/User";
import { getStripe } from "../utils/stripe.utils";
import logger from "../config/logger";

const getFrontendBaseUrl = (): string => {
  return process.env.FRONTEND_BASE_URL || "http://localhost:3000";
};

/**
 * POST /api/payments/connect/create-account
 * Initiates or retrieves a Stripe Connect Express account for the promoter.
 */
export const createConnectAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const stripe = getStripe();
    if (!stripe) {
      // In development mode when Stripe key is placeholder, simulate connect account ID
      if (process.env.NODE_ENV !== "production") {
        if (!user.stripeConnectAccountId) {
          user.stripeConnectAccountId = `acct_test_${user._id.toString().slice(-12)}`;
          await user.save();
        }
        res.status(200).json({
          success: true,
          message: "Stripe Connect account created (Dev Mode Simulator)",
          accountId: user.stripeConnectAccountId,
          isSimulated: true
        });
        return;
      }

      res.status(503).json({
        success: false,
        message: "Stripe platform secret is not configured in environment."
      });
      return;
    }

    if (user.stripeConnectAccountId) {
      try {
        const existing = await stripe.accounts.retrieve(user.stripeConnectAccountId);
        res.status(200).json({
          success: true,
          message: "Existing Stripe Connect account found",
          accountId: existing.id,
          chargesEnabled: existing.charges_enabled,
          payoutsEnabled: existing.payouts_enabled,
          detailsSubmitted: existing.details_submitted
        });
        return;
      } catch (err: any) {
        logger.warn(`Stripe account ${user.stripeConnectAccountId} invalid or deleted, recreating: ${err.message}`);
      }
    }

    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: "individual",
      business_profile: {
        name: user.companyName || user.name || "Event Organizer",
        product_description: "Event ticket sales through Tropica NYC platform"
      }
    });

    user.stripeConnectAccountId = account.id;
    user.chargesEnabled = account.charges_enabled;
    user.payoutsEnabled = account.payouts_enabled;
    user.stripeConnectOnboarded = account.details_submitted;
    await user.save();

    logger.info(`Created Stripe Express Connect account ${account.id} for user ${user.email}`);

    res.status(201).json({
      success: true,
      message: "Stripe Connect Express account initialized successfully",
      accountId: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted
    });
  } catch (error: any) {
    logger.error("Failed to create Stripe Connect account", { error: error.message });
    next(new Error(`Failed to create Stripe Connect account: ${error.message}`));
  }
};

/**
 * POST /api/payments/connect/onboarding-link
 * Generates the secure Stripe hosted onboarding URL.
 */
export const getConnectOnboardingLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const stripe = getStripe();
    const baseUrl = getFrontendBaseUrl();
    const returnUrl = `${baseUrl}/promoter/payouts?connect=success`;
    const refreshUrl = `${baseUrl}/promoter/payouts?connect=refresh`;

    if (!stripe || (user.stripeConnectAccountId && user.stripeConnectAccountId.startsWith("acct_test_"))) {
      // Dev mode simulator URL
      res.status(200).json({
        success: true,
        url: `${baseUrl}/promoter/payouts?connect=simulated_success`,
        isSimulated: true
      });
      return;
    }

    if (!user.stripeConnectAccountId) {
      res.status(400).json({
        success: false,
        message: "No connected account found. Please initialize Stripe Connect first."
      });
      return;
    }

    const accountLink = await stripe.accountLinks.create({
      account: user.stripeConnectAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding"
    });

    res.status(200).json({
      success: true,
      url: accountLink.url
    });
  } catch (error: any) {
    logger.error("Failed to create account onboarding link", { error: error.message });
    next(new Error(`Failed to create account onboarding link: ${error.message}`));
  }
};


/* ───────── Connect status helpers ───────── */

type ConnectState = "not_connected" | "incomplete" | "pending" | "connected";

const REQUIREMENT_LABELS: Array<[RegExp, string]> = [
  [/^external_account/, "Bank account for payouts"],
  [/^individual\.(first_name|last_name)/, "Legal name"],
  [/^individual\.dob/, "Date of birth"],
  [/^individual\.address/, "Home address"],
  [/^individual\.(ssn_last_4|id_number)/, "SSN (last 4 digits)"],
  [/^individual\.phone/, "Phone number"],
  [/^individual\.email/, "Email address"],
  [/^individual\.verification/, "ID document"],
  [/^business_profile\.mcc/, "Business category"],
  [/^business_profile\.(url|product_description)/, "Website or business description"],
  [/^settings\.payments\.statement_descriptor/, "Card statement name"],
  [/^tos_acceptance/, "Accept Stripe's terms"]
];

const friendlyRequirements = (fields: string[] = []): string[] => {
  const out: string[] = [];
  for (const f of fields) {
    const hit = REQUIREMENT_LABELS.find(([re]) => re.test(f));
    const label = hit ? hit[1] : "Other account details";
    if (!out.includes(label)) out.push(label);
  }
  return out;
};

/** "connected" = the promoter can receive ticket money (what checkout's destination charge needs). */
const describeAccount = (account: any) => {
  const transfersActive = account.capabilities?.transfers === "active";
  const canReceive = Boolean(account.charges_enabled && transfersActive);
  const due: string[] = [...(account.requirements?.past_due || []), ...(account.requirements?.currently_due || [])];
  const state: ConnectState = canReceive ? "connected" : account.details_submitted ? "pending" : "incomplete";
  return {
    state,
    connected: canReceive,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    requirements: friendlyRequirements(due),
    disabledReason: account.requirements?.disabled_reason || null
  };
};

/** The simulator only makes sense when no real Stripe key is configured (local dev). */
const simulatorAvailable = () => !getStripe() && process.env.NODE_ENV !== "production";

/**
 * GET /api/payments/connect/status
 * Synchronizes and retrieves the promoter's Stripe Connect status.
 */
export const getConnectAccountStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    if (!user.stripeConnectAccountId) {
      res.status(200).json({
        success: true,
        state: "not_connected",
        connected: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirements: [],
        simulatorAvailable: simulatorAvailable()
      });
      return;
    }

    const stripe = getStripe();
    if (!stripe || user.stripeConnectAccountId.startsWith("acct_test_")) {
      const simConnected = Boolean(user.chargesEnabled);
      res.status(200).json({
        success: true,
        state: simConnected ? "connected" : "incomplete",
        connected: simConnected,
        requirements: [],
        simulatorAvailable: simulatorAvailable(),
        accountId: user.stripeConnectAccountId,
        chargesEnabled: user.chargesEnabled ?? true,
        payoutsEnabled: user.payoutsEnabled ?? true,
        detailsSubmitted: user.stripeConnectOnboarded ?? true,
        isSimulated: true
      });
      return;
    }

    const account = await stripe.accounts.retrieve(user.stripeConnectAccountId);
    const info = describeAccount(account);

    // chargesEnabled is what checkout checks before routing money to the promoter
    user.chargesEnabled = info.connected;
    user.payoutsEnabled = account.payouts_enabled;
    user.stripeConnectOnboarded = account.details_submitted;
    await user.save();

    res.status(200).json({
      success: true,
      accountId: account.id,
      simulatorAvailable: false,
      ...info
    });
  } catch (error: any) {
    next(new Error(`Failed to retrieve Connect status: ${error.message}`));
  }
};

/**
 * POST /api/payments/connect/dashboard-link
 * Generates an Express dashboard login link for the promoter to view Stripe payouts.
 */
export const getConnectDashboardLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user || !user.stripeConnectAccountId) {
      res.status(400).json({ success: false, message: "No connected Stripe account found" });
      return;
    }

    const stripe = getStripe();
    if (!stripe || user.stripeConnectAccountId.startsWith("acct_test_")) {
      res.status(200).json({
        success: true,
        url: "https://dashboard.stripe.com/test",
        isSimulated: true
      });
      return;
    }

    const loginLink = await stripe.accounts.createLoginLink(user.stripeConnectAccountId);
    res.status(200).json({
      success: true,
      url: loginLink.url
    });
  } catch (error: any) {
    next(new Error(`Failed to create Stripe dashboard link: ${error.message}`));
  }
};

/**
 * POST /api/payments/connect/simulate-onboarding
 * Helper for test environments to verify end-to-end ticketing when live bank verification isn't active.
 */
export const simulateTestOnboarding = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    if (!simulatorAvailable()) {
      res.status(400).json({
        success: false,
        message: "Test-mode simulation is disabled because real Stripe is configured. Please complete Stripe onboarding instead."
      });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    user.stripeConnectAccountId = user.stripeConnectAccountId || `acct_test_${user._id.toString().slice(-12)}`;
    user.chargesEnabled = true;
    user.payoutsEnabled = true;
    user.stripeConnectOnboarded = true;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Test promoter account marked as onboarded for ticket selling",
      user: {
        chargesEnabled: user.chargesEnabled,
        payoutsEnabled: user.payoutsEnabled,
        stripeConnectOnboarded: user.stripeConnectOnboarded
      }
    });
  } catch (error: any) {
    next(new Error(`Simulation failed: ${error.message}`));
  }
};


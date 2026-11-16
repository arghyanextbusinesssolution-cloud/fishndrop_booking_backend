/**
 * Marketplace price math — pure functions, shared by the request, quote, payment and
 * settlement code so every screen shows the same numbers.
 *
 * Example (from the business brief): regular $2,000, partner discount 15%, customer discount 5%
 *   customerPrice = 2000 × 0.95 = 1900   (what the customer pays)
 *   venuePayout   = 2000 × 0.85 = 1700   (what the venue receives)
 *   commission    = 1900 − 1700 = 200    (Tropica's cut → Stripe application_fee)
 */

export interface VenuePricingTerms {
  pricingMode: "hourly" | "flat";
  basePrice: number;
  minHours: number;
  partnerDiscountPct: number;
  customerDiscountPct: number;
  depositPct: number;
  packages?: Array<{ _id?: unknown; name: string; price: number; hours: number }>;
}

export interface PriceBreakdown {
  regularPrice: number;
  customerPrice: number;
  customerSavings: number;
  venuePayout: number;
  commission: number;
  depositPct: number;
  depositAmount: number;
  remainingAmount: number;
}

export const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const pct = (n: number): number => Math.min(100, Math.max(0, Number(n) || 0)) / 100;

/** The venue's list ("regular") price for a booking, before any discount. */
export const regularPriceFor = (
  terms: VenuePricingTerms,
  durationHours: number,
  packageId?: string
): { regularPrice: number; packageName?: string; hours: number } => {
  if (packageId && terms.packages?.length) {
    const pkg = terms.packages.find((p) => String(p._id) === String(packageId));
    if (pkg) return { regularPrice: round2(pkg.price), packageName: pkg.name, hours: pkg.hours };
  }
  const hours = Math.max(terms.minHours || 1, durationHours);
  const regularPrice = terms.pricingMode === "flat" ? terms.basePrice : terms.basePrice * hours;
  return { regularPrice: round2(regularPrice), hours };
};

/** Split a regular price into customer price, venue payout, commission and deposit. */
export const computeBreakdown = (
  regularPrice: number,
  terms: Pick<VenuePricingTerms, "partnerDiscountPct" | "customerDiscountPct" | "depositPct">
): PriceBreakdown => {
  const customerPrice = round2(regularPrice * (1 - pct(terms.customerDiscountPct)));
  const venuePayout = round2(regularPrice * (1 - pct(terms.partnerDiscountPct)));
  return finish(regularPrice, customerPrice, venuePayout, terms.depositPct);
};

/**
 * Sarah overrides the final customer price when she confirms availability. The venue's payout
 * stays tied to the regular price (the negotiated partner rate), so the override moves
 * Tropica's commission — and can never push the venue below its agreed payout.
 */
export const computeOverrideBreakdown = (
  regularPrice: number,
  finalCustomerPrice: number,
  terms: Pick<VenuePricingTerms, "partnerDiscountPct" | "depositPct">
): PriceBreakdown => {
  const venuePayout = round2(regularPrice * (1 - pct(terms.partnerDiscountPct)));
  if (finalCustomerPrice < venuePayout) {
    throw new Error(`Final price cannot be below the venue payout of $${venuePayout.toFixed(2)}`);
  }
  return finish(regularPrice, round2(finalCustomerPrice), venuePayout, terms.depositPct);
};

/**
 * Venue payout + Tropica commission for a price the customer was already quoted, using the venue's
 * partner rate as the admin has it set now. The customer's price never changes here.
 */
export const splitAtCurrentRate = (regularPrice: number, customerPrice: number, partnerDiscountPct: number) => {
  const venuePayout = Math.min(round2(customerPrice), round2(regularPrice * (1 - pct(partnerDiscountPct))));
  return { venuePayout, commission: round2(customerPrice - venuePayout) };
};

const finish = (regularPrice: number, customerPrice: number, venuePayout: number, depositPctRaw: number): PriceBreakdown => {
  const depositPct = Math.min(100, Math.max(1, Number(depositPctRaw) || 100));
  const depositAmount = round2(customerPrice * (depositPct / 100));
  return {
    regularPrice: round2(regularPrice),
    customerPrice,
    customerSavings: round2(regularPrice - customerPrice),
    venuePayout,
    commission: round2(customerPrice - venuePayout),
    depositPct,
    depositAmount,
    remainingAmount: round2(customerPrice - depositAmount)
  };
};

/**
 * Tropica's share of one payment (deposit or balance), pro-rated so deposit + balance fees
 * add up to exactly the total commission. Pass the commission already collected so rounding
 * on the final payment absorbs any cent differences.
 */
export const applicationFeeFor = (
  chargeAmount: number,
  booking: { customerPrice: number; commission: number },
  commissionAlreadyCollected = 0,
  isFinalPayment = false
): number => {
  if (booking.customerPrice <= 0 || booking.commission <= 0) return 0;
  if (isFinalPayment) return round2(Math.max(0, booking.commission - commissionAlreadyCollected));
  return round2(booking.commission * (chargeAmount / booking.customerPrice));
};

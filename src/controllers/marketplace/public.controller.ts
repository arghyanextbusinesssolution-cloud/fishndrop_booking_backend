import { NextFunction, Request, Response } from "express";
import PartnerVenue, { IPartnerVenue, resolveWeeklyHours } from "../../models/PartnerVenue";
import { availableSlots, availableVenuesOn, isValidSessionDate } from "../../services/marketplace/availability.service";
import { PriceBreakdown, computeBreakdown, regularPriceFor } from "../../services/marketplace/pricing.service";

/** Strip Tropica's commission and the partner rate before anything reaches a customer. */
export const customerPriceView = (p: PriceBreakdown) => ({
  regularPrice: p.regularPrice,
  customerPrice: p.customerPrice,
  customerSavings: p.customerSavings,
  depositPct: p.depositPct,
  depositAmount: p.depositAmount,
  remainingAmount: p.remainingAmount
});

/** What customers may see — no owner contact, Stripe or internal fields. */
export const toPublicVenue = (v: IPartnerVenue) => {
  const fromRegular = v.packages?.length
    ? Math.min(...v.packages.map((p) => p.price))
    : regularPriceFor(v, v.minHours || 1).regularPrice;
  const from = computeBreakdown(fromRegular, v);
  return {
    _id: v._id,
    name: v.name,
    slug: v.slug,
    tagline: v.tagline,
    description: v.description,
    address: v.address,
    neighborhood: v.neighborhood,
    city: v.city,
    lat: v.lat,
    lng: v.lng,
    venueType: v.venueType,
    amenities: v.amenities,
    rules: v.rules,
    cancellationPolicy: v.cancellationPolicy,
    minGuests: v.minGuests,
    maxGuests: v.maxGuests,
    pricingMode: v.pricingMode,
    minHours: v.minHours,
    // Customer-facing prices only (already discounted) — never the partner rate.
    hourlyPrice: v.pricingMode === "hourly" ? computeBreakdown(v.basePrice, v).customerPrice : undefined,
    priceFrom: from.customerPrice,
    regularPriceFrom: from.regularPrice,
    customerDiscountPct: v.customerDiscountPct,
    depositPct: v.depositPct,
    packages: (v.packages || []).map((p) => ({
      _id: p._id,
      name: p.name,
      hours: p.hours,
      description: p.description,
      price: computeBreakdown(p.price, v).customerPrice,
      regularPrice: p.price
    })),
    openTime: v.openTime,
    closeTime: v.closeTime,
    weeklyHours: resolveWeeklyHours(v),
    theme: v.theme,
    logoUrl: v.logoUrl,
    flyerUrl: v.flyerUrl,
    coverUrl: v.coverUrl,
    photos: v.photos
  };
};

/** GET /api/marketplace/venues?date=YYYY-MM-DD&guests=&maxBudget=&type=&amenity=&q= */
export const listVenues = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const date = String(req.query.date || "");
    const guests = Number(req.query.guests) || undefined;
    const maxBudget = Number(req.query.maxBudget) || undefined;
    const type = String(req.query.type || "").trim();
    const amenities = String(req.query.amenity || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    const q = String(req.query.q || "").trim().toLowerCase();

    let rows: Array<{ venue: IPartnerVenue; available: boolean | null }>;
    if (date) {
      if (!isValidSessionDate(date)) {
        res.status(400).json({ success: false, message: "date must be YYYY-MM-DD" });
        return;
      }
      rows = await availableVenuesOn(date, guests);
    } else {
      const query: Record<string, unknown> = { status: "published" };
      if (guests) query.maxGuests = { $gte: guests };
      rows = (await PartnerVenue.find(query).sort({ name: 1 })).map((venue) => ({ venue, available: null }));
    }

    const venues = rows
      .map(({ venue, available }) => ({ ...toPublicVenue(venue), available }))
      .filter((v) => !type || v.venueType === type)
      .filter((v) => !maxBudget || v.priceFrom <= maxBudget)
      .filter((v) => amenities.every((a) => v.amenities.some((x) => x.toLowerCase().includes(a))))
      .filter(
        (v) =>
          !q ||
          [v.name, v.neighborhood, v.address, v.city, v.tagline].some((f) => String(f || "").toLowerCase().includes(q))
      )
      // Available first, then by price.
      .sort((a, b) => Number(b.available !== false) - Number(a.available !== false) || a.priceFrom - b.priceFrom);

    res.status(200).json({ success: true, venues });
  } catch (error) {
    next(error);
  }
};

/** GET /api/marketplace/venues/:slug */
export const getVenue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findOne({ slug: String(req.params.slug).toLowerCase(), status: "published" });
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }
    res.status(200).json({ success: true, venue: toPublicVenue(venue) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/marketplace/venues/:slug/slots?date=YYYY-MM-DD&hours=4&packageId= */
export const getVenueSlots = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venue = await PartnerVenue.findOne({ slug: String(req.params.slug).toLowerCase(), status: "published" });
    if (!venue) {
      res.status(404).json({ success: false, message: "Venue not found" });
      return;
    }
    const date = String(req.query.date || "");
    if (!isValidSessionDate(date)) {
      res.status(400).json({ success: false, message: "date must be YYYY-MM-DD" });
      return;
    }
    const packageId = req.query.packageId ? String(req.query.packageId) : undefined;
    const priced = regularPriceFor(venue, Number(req.query.hours) || venue.minHours, packageId);
    const slots = await availableSlots(venue, date, priced.hours);
    res.status(200).json({
      success: true,
      hours: priced.hours,
      packageName: priced.packageName,
      price: customerPriceView(computeBreakdown(priced.regularPrice, venue)),
      slots
    });
  } catch (error) {
    next(error);
  }
};

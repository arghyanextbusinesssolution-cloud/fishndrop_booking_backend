/**
 * Seeds 5 sample partner venues for local development / QA of the marketplace.
 * Safe to re-run: upserts by slug.
 *
 *   npm run seed-venues                 → insert/update the 5 venues as published
 *   npm run seed-venues -- --draft      → insert them hidden from customers (status "draft")
 *   npm run seed-venues -- --remove     → delete the sample venues (and their blocks)
 */
import "../config/loadEnv";
import mongoose from "mongoose";
import connectDB from "../config/db";
import PartnerVenue from "../models/PartnerVenue";
import VenueBlock from "../models/VenueBlock";

const SAMPLE_VENUES = [
  {
    name: "Skyline Loft",
    slug: "skyline-loft",
    coverUrl: "/venues/skyline-loft-cover.svg",
    logoUrl: "/venues/skyline-loft-logo.svg",
    flyerUrl: "/venues/skyline-loft-flyer.svg",
    photos: ["/venues/skyline-loft-cover.svg", "/venues/skyline-loft-photo-1.svg", "/venues/skyline-loft-photo-2.svg"],
    // Dummy owner contact — example.com so no real person gets request emails
    ownerName: "Maya Chen",
    ownerEmail: "owner+skyline-loft@example.com",
    ownerPhone: "+1 555 010 0001",
    cancellationPolicy: "Full refund up to 14 days before the event; 50% refund up to 7 days before; no refund after that.",
    agreementSignedAt: new Date("2026-11-01"),
    tagline: "Rooftop loft with Manhattan skyline views",
    description: "A bright industrial loft with a wraparound terrace, perfect for birthdays and cocktail parties.",
    address: "Williamsburg, Brooklyn, NY",
    neighborhood: "Williamsburg",
    venueType: "rooftop",
    amenities: ["Rooftop terrace", "Sound system", "Bar setup", "Restrooms", "Elevator access"],
    rules: ["No confetti", "Music off by 1:00 AM", "Outside catering allowed"],
    minGuests: 20,
    maxGuests: 120,
    pricingMode: "hourly",
    basePrice: 500,
    minHours: 4,
    partnerDiscountPct: 15,
    customerDiscountPct: 5,
    depositPct: 30,
    openTime: "12:00",
    closeTime: "23:00",
    theme: { primary: "#F2A65A", primaryContainer: "#1D2D44", onPrimary: "#1D2D44", background: "#0D1321", surface: "#1D2D44", onSurface: "#F0EBD8", accent: "#748CAB" }
  },
  {
    name: "The Garden House",
    slug: "the-garden-house",
    coverUrl: "/venues/the-garden-house-cover.svg",
    logoUrl: "/venues/the-garden-house-logo.svg",
    flyerUrl: "/venues/the-garden-house-flyer.svg",
    photos: ["/venues/the-garden-house-cover.svg", "/venues/the-garden-house-photo-1.svg", "/venues/the-garden-house-photo-2.svg"],
    // Dummy owner contact — example.com so no real person gets request emails
    ownerName: "Daniel Ortiz",
    ownerEmail: "owner+the-garden-house@example.com",
    ownerPhone: "+1 555 010 0002",
    cancellationPolicy: "Full refund up to 14 days before the event; 50% refund up to 7 days before; no refund after that.",
    agreementSignedAt: new Date("2026-11-01"),
    tagline: "Lush private garden for daytime celebrations",
    description: "A greenhouse-style space opening onto a private garden. Ideal for showers, brunches and intimate weddings.",
    address: "Park Slope, Brooklyn, NY",
    neighborhood: "Park Slope",
    venueType: "garden",
    amenities: ["Private garden", "Tables & chairs", "Kitchen access", "String lights"],
    rules: ["Events end by 10:00 PM", "No open flames"],
    minGuests: 10,
    maxGuests: 60,
    pricingMode: "flat",
    basePrice: 2000,
    minHours: 5,
    packages: [
      { name: "Half day (5 hrs)", price: 2000, hours: 5, description: "Venue, tables, chairs and lighting" },
      { name: "Full day (10 hrs)", price: 3600, hours: 10, description: "Includes setup and breakdown time" }
    ],
    partnerDiscountPct: 15,
    customerDiscountPct: 5,
    depositPct: 50,
    openTime: "09:00",
    closeTime: "22:00",
    theme: { primary: "#4F772D", primaryContainer: "#ECF39E", onPrimary: "#FFFFFF", background: "#F7F9EF", surface: "#ECF2DC", onSurface: "#132A13", accent: "#90A955" }
  },
  {
    name: "Velvet Lounge",
    slug: "velvet-lounge",
    coverUrl: "/venues/velvet-lounge-cover.svg",
    logoUrl: "/venues/velvet-lounge-logo.svg",
    flyerUrl: "/venues/velvet-lounge-flyer.svg",
    photos: ["/venues/velvet-lounge-cover.svg", "/venues/velvet-lounge-photo-1.svg", "/venues/velvet-lounge-photo-2.svg"],
    // Dummy owner contact — example.com so no real person gets request emails
    ownerName: "Rico Valentine",
    ownerEmail: "owner+velvet-lounge@example.com",
    ownerPhone: "+1 555 010 0003",
    cancellationPolicy: "Full refund up to 14 days before the event; 50% refund up to 7 days before; no refund after that.",
    agreementSignedAt: new Date("2026-11-01"),
    tagline: "Moody speakeasy lounge with a private bar",
    description: "Dark velvet booths, a full private bar and a DJ booth. Built for late-night parties.",
    address: "Lower East Side, New York, NY",
    neighborhood: "Lower East Side",
    venueType: "lounge",
    amenities: ["Private bar", "DJ booth", "Coat check", "VIP booths"],
    rules: ["21+ only", "Bar service through the venue only"],
    minGuests: 25,
    maxGuests: 150,
    pricingMode: "hourly",
    basePrice: 650,
    minHours: 3,
    partnerDiscountPct: 20,
    customerDiscountPct: 5,
    depositPct: 25,
    openTime: "18:00",
    closeTime: "23:00",
    theme: { primary: "#C9184A", primaryContainer: "#590D22", onPrimary: "#FFFFFF", background: "#14080E", surface: "#2B0F1C", onSurface: "#FFE5EC", accent: "#FF8FA3" }
  },
  {
    name: "Harbor Hall",
    slug: "harbor-hall",
    coverUrl: "/venues/harbor-hall-cover.svg",
    logoUrl: "/venues/harbor-hall-logo.svg",
    flyerUrl: "/venues/harbor-hall-flyer.svg",
    photos: ["/venues/harbor-hall-cover.svg", "/venues/harbor-hall-photo-1.svg", "/venues/harbor-hall-photo-2.svg"],
    // Dummy owner contact — example.com so no real person gets request emails
    ownerName: "Priya Nair",
    ownerEmail: "owner+harbor-hall@example.com",
    ownerPhone: "+1 555 010 0004",
    cancellationPolicy: "Full refund up to 14 days before the event; 50% refund up to 7 days before; no refund after that.",
    agreementSignedAt: new Date("2026-11-01"),
    tagline: "Waterfront hall for corporate events and galas",
    description: "A large waterfront hall with AV, stage and breakout rooms.",
    address: "DUMBO, Brooklyn, NY",
    neighborhood: "DUMBO",
    venueType: "banquet_hall",
    amenities: ["Stage", "Projector & screens", "Breakout rooms", "Wheelchair accessible", "Parking nearby"],
    rules: ["Licensed caterers only", "Load-in 2 hours before event"],
    minGuests: 50,
    maxGuests: 300,
    pricingMode: "hourly",
    basePrice: 900,
    minHours: 4,
    partnerDiscountPct: 12,
    customerDiscountPct: 3,
    depositPct: 40,
    openTime: "08:00",
    closeTime: "23:00",
    theme: { primary: "#0077B6", primaryContainer: "#CAF0F8", onPrimary: "#FFFFFF", background: "#F4FAFD", surface: "#E3F2FA", onSurface: "#03045E", accent: "#00B4D8" }
  },
  {
    name: "Studio 54th",
    slug: "studio-54th",
    coverUrl: "/venues/studio-54th-cover.svg",
    logoUrl: "/venues/studio-54th-logo.svg",
    flyerUrl: "/venues/studio-54th-flyer.svg",
    photos: ["/venues/studio-54th-cover.svg", "/venues/studio-54th-photo-1.svg", "/venues/studio-54th-photo-2.svg"],
    // Dummy owner contact — example.com so no real person gets request emails
    ownerName: "Jordan Blake",
    ownerEmail: "owner+studio-54th@example.com",
    ownerPhone: "+1 555 010 0005",
    cancellationPolicy: "Full refund up to 14 days before the event; 50% refund up to 7 days before; no refund after that.",
    agreementSignedAt: new Date("2026-11-01"),
    tagline: "Blank-canvas photo studio for small creative events",
    description: "A white-cyc studio with natural light. Great for pop-ups, shoots and small private dinners.",
    address: "Midtown, New York, NY",
    neighborhood: "Midtown",
    venueType: "studio",
    amenities: ["Natural light", "White cyclorama", "Wi-Fi", "Kitchenette"],
    rules: ["No red wine on the cyc", "Shoes off on the cyc"],
    minGuests: 5,
    maxGuests: 40,
    pricingMode: "hourly",
    basePrice: 200,
    minHours: 2,
    partnerDiscountPct: 15,
    customerDiscountPct: 5,
    depositPct: 100,
    openTime: "08:00",
    closeTime: "22:00",
    theme: { primary: "#111111", primaryContainer: "#EDEDED", onPrimary: "#FFFFFF", background: "#FFFFFF", surface: "#F5F5F5", onSurface: "#111111", accent: "#FF5A1F" }
  }
];

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  await connectDB();

  if (args.includes("--remove")) {
    const slugs = SAMPLE_VENUES.map((v) => v.slug);
    const venues = await PartnerVenue.find({ slug: { $in: slugs } }, "_id");
    await VenueBlock.deleteMany({ venue: { $in: venues.map((v) => v._id) } });
    const { deletedCount } = await PartnerVenue.deleteMany({ slug: { $in: slugs } });
    console.log(`Removed ${deletedCount} sample partner venues.`);
    return;
  }

  const status = args.includes("--draft") ? "draft" : "published";
  for (const venue of SAMPLE_VENUES) {
    await PartnerVenue.findOneAndUpdate(
      { slug: venue.slug },
      { $set: { ...venue, status } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    console.log(`✔ ${venue.name}`);
  }
  console.log(`Seeded ${SAMPLE_VENUES.length} partner venues (${status}).`);
};

main()
  .catch((err) => {
    console.error("Seeding partner venues failed:", err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

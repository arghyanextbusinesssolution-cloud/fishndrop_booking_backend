import { NextFunction, Request, Response } from "express";
import logger from "../config/logger";

/**
 * Venue address autocomplete for event creation.
 * Uses Google Places (New) when GOOGLE_MAPS_API_KEY is set; otherwise falls back to
 * OpenStreetMap Photon (free, no key). Results are biased toward New York City.
 */

export interface PlaceSuggestion {
  id: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

const NYC = { lat: 40.7128, lng: -74.006 };
const TIMEOUT_MS = 6000;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().replace(/<[^>]*>/g, "").slice(0, max) : "");
const googleKey = () => process.env.GOOGLE_MAPS_API_KEY || "";

const googleAutocomplete = async (q: string, sessionToken: string): Promise<PlaceSuggestion[]> => {
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": googleKey() },
    body: JSON.stringify({
      input: q,
      includedRegionCodes: ["us"],
      locationBias: { circle: { center: { latitude: NYC.lat, longitude: NYC.lng }, radius: 50000 } },
      ...(sessionToken ? { sessionToken } : {})
    })
  });
  if (!res.ok) throw new Error(`Google autocomplete ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return (data.suggestions || [])
    .map((s: any) => s.placePrediction)
    .filter(Boolean)
    .map((p: any) => ({
      id: p.placeId,
      name: p.structuredFormat?.mainText?.text || p.text?.text || "",
      address: p.text?.text || ""
    }));
};

const googleDetails = async (placeId: string, sessionToken: string): Promise<PlaceSuggestion> => {
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "X-Goog-Api-Key": googleKey(), "X-Goog-FieldMask": "id,displayName,formattedAddress,location" }
  });
  if (!res.ok) throw new Error(`Google details ${res.status}`);
  const p: any = await res.json();
  return {
    id: p.id,
    name: p.displayName?.text || "",
    address: p.formattedAddress || "",
    lat: p.location?.latitude,
    lng: p.location?.longitude
  };
};

const photonAutocomplete = async (q: string): Promise<PlaceSuggestion[]> => {
  // Bias to NYC and restrict to the continental US (events are US-only)
  const url =
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=12&lang=en` +
    `&lat=${NYC.lat}&lon=${NYC.lng}&bbox=-125,24,-66,50`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "TropicaEvents/1.0 (venue autocomplete)" }
  });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data: any = await res.json();
  return (data.features || [])
    .filter((f: any) => (f.properties?.countrycode || "").toUpperCase() === "US")
    .slice(0, 6)
    .map((f: any) => {
    const p = f.properties || {};
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const country = p.countrycode === "US" ? "" : p.country;
    const parts = [street, p.district, p.city || p.county, [p.state, p.postcode].filter(Boolean).join(" "), country]
      .filter(Boolean)
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const name = p.name || street || parts[0] || "";
    const address = [p.name && p.name !== street ? p.name : "", ...parts].filter(Boolean).join(", ");
    return {
      id: `osm:${p.osm_type || ""}${p.osm_id || ""}`,
      name,
      address,
      lng: f.geometry?.coordinates?.[0],
      lat: f.geometry?.coordinates?.[1]
    };
  });
};

/** GET /api/places/autocomplete?q=&session= */
export const autocompletePlaces = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = clean(req.query.q, 120);
    const session = clean(req.query.session, 100);
    if (q.length < 3) {
      res.status(200).json({ success: true, provider: googleKey() ? "google" : "osm", suggestions: [] });
      return;
    }
    if (googleKey()) {
      try {
        res.status(200).json({ success: true, provider: "google", suggestions: await googleAutocomplete(q, session) });
        return;
      } catch (err: any) {
        logger.warn("[Places] Google autocomplete failed, falling back to OSM", { error: err.message });
      }
    }
    res.status(200).json({ success: true, provider: "osm", suggestions: await photonAutocomplete(q) });
  } catch (error: any) {
    logger.error("[Places] autocomplete failed", { error: error.message });
    res.status(502).json({ success: false, message: "Address search is unavailable right now. Please type the address." });
  }
};

/** GET /api/places/details?id=&session=  (Google only — OSM suggestions already include coordinates) */
export const placeDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = clean(req.query.id, 300);
    const session = clean(req.query.session, 100);
    if (!id || id.startsWith("osm:") || !googleKey()) {
      res.status(400).json({ success: false, message: "Unknown place" });
      return;
    }
    res.status(200).json({ success: true, place: await googleDetails(id, session) });
  } catch (error: any) {
    logger.error("[Places] details failed", { error: error.message });
    res.status(502).json({ success: false, message: "Could not load this place" });
  }
};

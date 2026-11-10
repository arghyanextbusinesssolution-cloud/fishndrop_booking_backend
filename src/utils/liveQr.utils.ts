import crypto from "crypto";

/**
 * Rotating ("live") ticket QR codes.
 *
 * The door QR is `tk_<ticketId>_<issuedAt>_<signature>`, where issuedAt is the issue time in
 * seconds (base 36). The signature binds the ticket id, the ticket's current qrCodeToken (rotated
 * whenever the seat changes hands) and the issue time, using a server-only secret.
 *
 * Each code admits for LIVE_QR_LIFETIME_MS (5 minutes) after it was issued. The guest's phone
 * fetches a fresh code shortly before that, so a screenshot stops scanning within 5 minutes and a
 * previous holder's code dies immediately on reassignment.
 */
export const LIVE_QR_LIFETIME_MS = 5 * 60 * 1000;
/** The phone asks for the next code this long before the current one expires. */
const REFRESH_BEFORE_EXPIRY_MS = 15_000;
/** Tolerate the phone/server clocks being slightly apart. */
const CLOCK_SKEW_MS = 30_000;

const PREFIX = "tk_";
const FORMAT = /^tk_([a-f0-9]{24})_([a-z0-9]{1,10})_([a-f0-9]{24})$/;

const secret = (): string => {
  const s = process.env.QR_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error("QR_SIGNING_SECRET (or JWT_SECRET) must be set");
  return s;
};

const sign = (ticketId: string, qrCodeToken: string, issuedSec: number): string =>
  crypto.createHmac("sha256", secret()).update(`${ticketId}.${qrCodeToken}.${issuedSec}`).digest("hex").slice(0, 24);

export const isLiveQrToken = (raw: string): boolean => raw.startsWith(PREFIX);

/** Issue a code valid for the next 5 minutes, plus when the phone should fetch the next one. */
export const issueLiveQr = (ticketId: string, qrCodeToken: string, now = Date.now()) => {
  const issuedSec = Math.floor(now / 1000);
  return {
    token: `${PREFIX}${ticketId}_${issuedSec.toString(36)}_${sign(ticketId, qrCodeToken, issuedSec)}`,
    refreshInMs: LIVE_QR_LIFETIME_MS - REFRESH_BEFORE_EXPIRY_MS,
    windowMs: LIVE_QR_LIFETIME_MS,
    expiresAt: new Date(issuedSec * 1000 + LIVE_QR_LIFETIME_MS).toISOString()
  };
};

/** Parse without verifying (to look up the ticket). */
export const parseLiveQr = (raw: string): { ticketId: string; issuedSec: number; sig: string } | null => {
  const m = FORMAT.exec(raw);
  if (!m) return null;
  const issuedSec = parseInt(m[2], 36);
  return Number.isFinite(issuedSec) ? { ticketId: m[1], issuedSec, sig: m[3] } : null;
};

/** "ok" within 5 minutes of issue, "expired" after, "invalid" if forged or for another holder. */
export const verifyLiveQr = (raw: string, qrCodeToken: string, now = Date.now()): "ok" | "expired" | "invalid" => {
  const parsed = parseLiveQr(raw);
  if (!parsed) return "invalid";
  const expected = Buffer.from(sign(parsed.ticketId, qrCodeToken, parsed.issuedSec));
  const given = Buffer.from(parsed.sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return "invalid";
  const age = now - parsed.issuedSec * 1000;
  if (age < -CLOCK_SKEW_MS) return "invalid";
  return age <= LIVE_QR_LIFETIME_MS ? "ok" : "expired";
};

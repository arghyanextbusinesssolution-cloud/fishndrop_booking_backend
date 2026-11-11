/**
 * Public website base URL used for links the backend builds (Stripe redirects, emails, invite links).
 * Set FRONTEND_BASE_URL on every server (e.g. https://www.tropica.nyc). If it is missing,
 * production falls back to the live site — never localhost — and local dev falls back to localhost.
 */
export const getFrontendBaseUrl = (): string => {
  const fallback = process.env.NODE_ENV === "production" ? "https://www.tropica.nyc" : "http://localhost:3000";
  return normalizeBaseUrl(process.env.FRONTEND_BASE_URL) || fallback;
};

/**
 * Turns whatever was typed into FRONTEND_BASE_URL into a clean origin, so links never come out as
 * "https://www.tropica.nyc//www.tropica.nyc/invite/…". Handles a missing scheme ("www.tropica.nyc"),
 * stray slashes ("//www.tropica.nyc/"), quotes, a list ("a,b" → first) and any trailing path.
 */
export const normalizeBaseUrl = (raw: string | undefined): string => {
  let value = (raw || "").trim().replace(/^['"]|['"]$/g, "").split(/[,\s]+/)[0] || "";
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    const host = value.replace(/^(?:https?:)?\/*/i, ""); // "https:www.x" / "//www.x" / "www.x" → "www.x"
    value = `${/^(localhost|127\.)/i.test(host) ? "http" : "https"}://${host}`;
  }
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
};

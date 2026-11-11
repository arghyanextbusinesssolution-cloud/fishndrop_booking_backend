/**
 * Public website base URL used for links the backend builds (Stripe redirects, emails, invite links).
 * Set FRONTEND_BASE_URL on every server (e.g. https://www.tropica.nyc). If it is missing,
 * production falls back to the live site — never localhost — and local dev falls back to localhost.
 */
export const getFrontendBaseUrl = (): string => {
  const configured = (process.env.FRONTEND_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? "https://www.tropica.nyc" : "http://localhost:3000";
};

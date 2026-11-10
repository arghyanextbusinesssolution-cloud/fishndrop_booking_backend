import fs from "fs";
import path from "path";
import Stripe from "stripe";
import { loadEnvFiles } from "../config/loadEnv";

const INVALID_PLACEHOLDER_SECRETS = new Set([
  "sk_test_placeholder_key_alpha",
  "sk_test_placeholder_key_beta"
]);

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
      /* continue */
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

export function readStripeSecretKey(): string | undefined {
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

export function getStripe(): StripeClient | null {
  const key = readStripeSecretKey();
  if (!key) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(key, { apiVersion: "2026-03-25.dahlia" as any });
  }
  return stripeClient;
}


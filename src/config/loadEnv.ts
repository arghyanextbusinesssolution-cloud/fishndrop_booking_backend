import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/**
 * Load `.env` from every path that exists. Later files only fill keys that are still missing
 * (`override: false` is the default).
 */
export function loadEnvFiles(): void {
  const candidates = [
    path.resolve(__dirname, "../../.env"),
    path.resolve(process.cwd(), "backend", ".env"),
    path.resolve(process.cwd(), ".env")
  ];
  const seen = new Set<string>();
  for (const envPath of candidates) {
    const key = path.normalize(envPath);
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }
}

loadEnvFiles();

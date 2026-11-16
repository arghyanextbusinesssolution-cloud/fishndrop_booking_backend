import dns from "dns";
import mongoose from "mongoose";
import logger from "./logger";

// Set IPv4 first to prevent Windows/ISP DNS SRV query failures with MongoDB Atlas
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Ignore in environments where setDefaultResultOrder is unavailable
}

/**
 * Connection strategy
 * ───────────────────
 * • First connect: retry with exponential backoff until it succeeds.
 * • After that, a dropped connection (Wi-Fi blip, ISP hiccup) is healed by the MongoDB driver
 *   itself — we must NOT call mongoose.connect() again on a connection that was already open:
 *   that call never settles, which used to leave us stuck "disconnected" until a restart.
 * • Watchdog: if the driver hasn't recovered within RECOVERY_GRACE_MS, close the connection
 *   cleanly and start over from scratch.
 */

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const CONNECT_TIMEOUT_MS = 20000; // hard cap so a hung connect can never block retries
const RECOVERY_GRACE_MS = 45000;
const WATCHDOG_INTERVAL_MS = 15000;

let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let isConnecting = false;
let hasConnectedOnce = false;
let disconnectedAt: number | null = null;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

const connectDB = async (): Promise<void> => {
  if (isConnecting || mongoose.connection.readyState === 1) {
    return;
  }

  isConnecting = true;
  try {
    await withTimeout(
      mongoose.connect(process.env.MONGODB_URI as string, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        heartbeatFrequencyMS: 10000,
        family: 4 // force IPv4 sockets; some ISPs/routers drop IPv6 to Atlas
      }),
      CONNECT_TIMEOUT_MS,
      "MongoDB connect"
    );
    hasConnectedOnce = true;
    reconnectAttempts = 0;
    disconnectedAt = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    logger.info("MongoDB connected successfully");
  } catch (error: any) {
    logger.error("MongoDB connection failed", { error: error?.message || String(error) });
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
};

const scheduleReconnect = (): void => {
  if (isConnecting || mongoose.connection.readyState === 1 || reconnectTimer) {
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), MAX_DELAY_MS);
  logger.warn("Scheduling MongoDB reconnect", { attempt: reconnectAttempts, delay });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectDB();
  }, delay);
};

/** Fallback when the driver can't heal a dropped connection: tear down and reconnect fresh. */
const startWatchdog = (): void => {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    if (mongoose.connection.readyState === 1) {
      stopWatchdog();
      return;
    }
    if (disconnectedAt && Date.now() - disconnectedAt > RECOVERY_GRACE_MS && !isConnecting) {
      logger.warn("MongoDB did not recover on its own — resetting the connection");
      stopWatchdog();
      try {
        await withTimeout(mongoose.connection.close(true), 10000, "MongoDB close");
      } catch (err: any) {
        logger.warn("MongoDB close during reset failed (continuing)", { error: err?.message });
      }
      disconnectedAt = Date.now();
      reconnectAttempts = 0;
      void connectDB();
    }
  }, WATCHDOG_INTERVAL_MS);
};

const stopWatchdog = (): void => {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
};

mongoose.connection.on("error", (error: any) => {
  logger.error("MongoDB connection error", { error: error?.message || String(error) });
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
  disconnectedAt = disconnectedAt ?? Date.now();
  if (hasConnectedOnce) {
    // Let the driver reconnect by itself; the watchdog steps in if it can't.
    startWatchdog();
  } else {
    scheduleReconnect();
  }
});

mongoose.connection.on("reconnected", () => {
  logger.info("MongoDB reconnected");
  disconnectedAt = null;
  stopWatchdog();
});

mongoose.connection.on("connected", () => {
  disconnectedAt = null;
  stopWatchdog();
});

export default connectDB;

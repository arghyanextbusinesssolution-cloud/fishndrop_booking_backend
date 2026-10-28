import dns from "dns";
import mongoose from "mongoose";
import logger from "./logger";

// Set IPv4 first to prevent Windows/ISP DNS SRV query failures with MongoDB Atlas
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Ignore in environments where setDefaultResultOrder is unavailable
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnecting = false;

const connectDB = async (): Promise<void> => {
  if (isConnecting || mongoose.connection.readyState === 1) {
    return;
  }

  isConnecting = true;
  try {
    await mongoose.connect(process.env.MONGODB_URI as string, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000
    });
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    logger.info("MongoDB connected successfully");
  } catch (error) {
    logger.error("MongoDB connection failed", { error });
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

mongoose.connection.on("error", (error) => {
  logger.error("MongoDB connection error", { error });
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
  scheduleReconnect();
});

export default connectDB;

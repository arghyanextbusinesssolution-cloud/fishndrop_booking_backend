import mongoose from "mongoose";
import logger from "./logger";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnecting = false;

const connectDB = async (): Promise<void> => {
  if (isConnecting) {
    return;
  }

  isConnecting = true;
  try {
    await mongoose.connect(process.env.MONGODB_URI as string, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });
    reconnectAttempts = 0;
    logger.info("MongoDB connected");
  } catch (error) {
    logger.error("MongoDB connection failed", { error });
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
};

const scheduleReconnect = (): void => {
  if (reconnectAttempts >= MAX_RETRIES) {
    logger.error("MongoDB reconnect attempts exhausted");
    return;
  }
  reconnectAttempts += 1;
  const delay = BASE_DELAY_MS * 2 ** (reconnectAttempts - 1);
  logger.warn("Scheduling MongoDB reconnect", { attempt: reconnectAttempts, delay });
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
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

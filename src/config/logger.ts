import fs from "fs";
import path from "path";
import { createLogger, format, transports } from "winston";

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const isProduction = process.env.NODE_ENV === "production";

const customFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  format.metadata({ fillExcept: ["message", "level", "timestamp"] }),
  format.printf(({ timestamp, level, message, metadata }) => {
    const metaString = metadata && Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : "";
    return `${timestamp} [${level}]: ${message}${metaString}`;
  })
);

const logger = createLogger({
  level: isProduction ? "warn" : "debug",
  format: customFormat,
  transports: [
    new transports.Console({
      format: isProduction
        ? customFormat
        : format.combine(format.colorize({ all: true }), customFormat)
    }),
    new transports.File({
      filename: path.join(logsDir, "app.log")
    })
  ]
});

export default logger;

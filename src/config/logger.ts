import pino from "pino";

// ---------------------------------------------------------------------------
// STRUCTURED LOGGING WITH PINO
// ---------------------------------------------------------------------------
// Pino is ~5x faster than console.log and outputs structured JSON logs
// compatible with EL Stack, Datadog, Splunk, and CloudWatch.
//
// Usage:
//   import { logger } from "../config/logger.js";
//   logger.info({ userId: 123 }, "User logged in");
//   logger.error({ err }, "Payment failed");
// ---------------------------------------------------------------------------

const isDevelopment = process.env.NODE_ENV === "development";
const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "glm-api",
  base: {
    pid: process.pid,
    service: "glm-ledger",
    version: process.env.API_VERSION ?? "1.0.0",
  },
  // In development, pretty-print. In production, raw JSON.
  ...(isDevelopment && !process.env.LOG_NO_PRETTY
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
  // Redact sensitive fields automatically
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.refresh_token",
      "req.body.access_token",
      "*.password",
      "*.password_hash",
      "*.token",
      "*.token_hash",
    ],
    censor: "[REDACTED]",
  },
  // In production, add hooks for additional processing
  hooks: {
    logMethod(inputArgs, method) {
      // Ensures proper formatting for Pino standards
      return method.apply(this, inputArgs);
    },
  },
});

// Child loggers for specific contexts
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export default logger;

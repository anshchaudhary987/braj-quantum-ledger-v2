import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { AppError } from "../auth/auth-service";
import { ErrorCode, ApiErrorResponse } from "../errors";
import { logger } from "../../config/logger";

/**
 * GLOBAL ERROR HANDLER — Catches all errors and returns the standard format.
 *
 * Standard response:
 * {
 *   "error": {
 *     "code": "INSUFFICIENT_STOCK",
 *     "message": "Insufficient stock for 'Computer Parts'...",
 *     "details": { "item_id": 50, "available": 5, "requested": 10 },
 *     "trace_id": "abc-123",
 *     "timestamp": "2026-05-07T10:30:00.000Z"
 *   }
 * }
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const traceId = req.traceId ?? crypto.randomUUID();

  if (err instanceof AppError) {
    const body: ApiErrorResponse = {
      error: {
        code: err.name as ErrorCode,
        message: err.message,
        details: err.details,
        trace_id: traceId,
        timestamp: new Date().toISOString(),
      },
    };

    // Log structured error for observability using Pino
    logger.error({
      level: "error",
      trace_id: traceId,
      code: err.name,
      message: err.message,
      path: req.path,
      method: req.method,
      userId: req.userId,
      companyId: req.companyId,
      ip: req.ip,
    });

    res.status(err.statusCode).json(body);
    return;
  }

  // Unexpected errors — sanitize in production
  const isProduction = process.env.NODE_ENV === "production";

  const body: ApiErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: isProduction
        ? "An unexpected error occurred. Please contact support with the trace ID."
        : err.message,
      details: isProduction ? undefined : { stack: err.stack },
      trace_id: traceId,
      timestamp: new Date().toISOString(),
    },
  };

  logger.error({
    trace_id: traceId,
    code: ErrorCode.INTERNAL_ERROR,
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.userId,
    companyId: req.companyId,
  }, "Unexpected error occurred");

  res.status(500).json(body);
}

/**
 * 404 HANDLER — For unmatched routes
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(
      ErrorCode.NOT_FOUND,
      `Route not found: ${req.method} ${req.path}`
    )
  );
}

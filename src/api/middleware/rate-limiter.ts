import { Request, Response, NextFunction } from "express";
import { ErrorCode } from "../errors.js";
import { AppError } from "../auth/auth-service.js";

/**
 * IN-MEMORY TOKEN-BUCKET RATE LIMITER
 *
 * For production with multiple server instances, replace with Redis-backed
 * implementation (e.g., using ioredis + sorted sets).
 *
 * Configuration:
 *   - Global:       100 requests per 15 minutes per IP
 *   - Auth routes:   20 requests per 15 minutes per IP (brute-force protection)
 *   - Voucher creation: 30 requests per minute per user
 */

interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

const GLOBAL_WINDOW_MS   = 15 * 60 * 1000;  // 15 minutes
const GLOBAL_MAX_REQUESTS = 100;

const AUTH_WINDOW_MS      = 15 * 60 * 1000;
const AUTH_MAX_REQUESTS   = 20;

const VOUCHER_WINDOW_MS   = 60 * 1000;       // 1 minute
const VOUCHER_MAX_REQUESTS = 30;

const buckets = new Map<string, BucketEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.lastRefill > GLOBAL_WINDOW_MS * 2) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000);

function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let entry = buckets.get(key);

  if (!entry) {
    entry = { tokens: maxRequests, lastRefill: now };
    buckets.set(key, entry);
  }

  // Refill tokens
  const elapsed = now - entry.lastRefill;
  const refillAmount = Math.floor((elapsed / windowMs) * maxRequests);

  if (refillAmount > 0) {
    entry.tokens = Math.min(maxRequests, entry.tokens + refillAmount);
    entry.lastRefill = now;
  }

  if (entry.tokens > 0) {
    entry.tokens--;
    return { allowed: true, retryAfter: 0 };
  }

  const retryAfter = Math.ceil(
    (windowMs - elapsed) / 1000
  );
  return { allowed: false, retryAfter };
}

export function globalRateLimiter(req: Request, _res: Response, next: NextFunction): void {
  const key = `global:${req.ip}`;
  const { allowed, retryAfter } = checkRateLimit(key, GLOBAL_MAX_REQUESTS, GLOBAL_WINDOW_MS);

  if (!allowed) {
    _res.set("Retry-After", String(retryAfter));
    _res.set("X-RateLimit-Limit", String(GLOBAL_MAX_REQUESTS));
    next(
      new AppError(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Too many requests. Please retry after ${retryAfter} seconds.`
      )
    );
    return;
  }

  _res.set("X-RateLimit-Remaining", String(buckets.get(key)?.tokens ?? 0));
  next();
}

export function authRateLimiter(req: Request, _res: Response, next: NextFunction): void {
  const key = `auth:${req.ip}`;
  const { allowed, retryAfter } = checkRateLimit(key, AUTH_MAX_REQUESTS, AUTH_WINDOW_MS);

  if (!allowed) {
    _res.set("Retry-After", String(retryAfter));
    next(
      new AppError(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Too many login attempts. Please retry after ${retryAfter} seconds.`
      )
    );
    return;
  }

  next();
}

export function voucherRateLimiter(req: Request, _res: Response, next: NextFunction): void {
  // Per-user limit (falls back to per-IP if not authenticated)
  const key = req.userId
    ? `voucher:user:${req.userId}`
    : `voucher:ip:${req.ip}`;

  const { allowed, retryAfter } = checkRateLimit(
    key, VOUCHER_MAX_REQUESTS, VOUCHER_WINDOW_MS
  );

  if (!allowed) {
    _res.set("Retry-After", String(retryAfter));
    next(
      new AppError(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Too many voucher requests. Please retry after ${retryAfter} seconds.`
      )
    );
    return;
  }

  next();
}

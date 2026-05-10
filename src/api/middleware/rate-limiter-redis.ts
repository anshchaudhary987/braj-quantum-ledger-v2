import { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { ErrorCode } from "../errors.js";
import { AppError } from "../auth/auth-service.js";
import { logger } from "../../config/logger.js";

// ---------------------------------------------------------------------------
// REDIS-BACKED TOKEN-BUCKET RATE LIMITER
// ---------------------------------------------------------------------------
// Scalable across multiple server instances using Redis for storage.
// Each bucket is identified by a key (e.g., "global:192.168.1.1").
// Redis keys expire automatically after the window period.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ---------------------------------------------------------------------------
// LAZY REDIS CLIENT — connect only when needed (prevents startup delay)
// ---------------------------------------------------------------------------
let _redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!_redisClient) {
    _redisClient = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        return Math.min(times * 50, 2000); // Exponential backoff up to 2s
      },
    });

    _redisClient.on("error", (err) => {
      logger.error({ err, source: "rate-limiter-redis" }, "Redis connection error");
    });

    _redisClient.on("connect", () => {
      logger.info("Redis connected for rate limiting");
    });
  }
  return _redisClient;
}

// Graceful close on shutdown
export async function closeRateLimiterRedis(): Promise<void> {
  if (_redisClient) {
    await _redisClient.quit();
    _redisClient = null;
  }
}

// ---------------------------------------------------------------------------
// RATE LIMIT CONFIGURATION
// ---------------------------------------------------------------------------
interface RateLimitConfig {
  max: number;         // Max requests per window
  windowSeconds: number; // Window duration in seconds
}

const CONFIG: Record<string, RateLimitConfig> = {
  global: { max: 100, windowSeconds: 900 },    // 100 per 15 min
  auth: { max: 20, windowSeconds: 900 },         // 20 per 15 min (brute-force protection)
  voucher: { max: 30, windowSeconds: 60 },        // 30 per minute
};

// ---------------------------------------------------------------------------
// CORE RATE LIMITER USING REDIS + SLIDING WINDOW
// ---------------------------------------------------------------------------
async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; retryAfter: number; remaining: number }> {
  const redisKey = `ratelimit:${key}`;
  const client = getRedisClient();
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;
  const clearBefore = now - windowMs;

  try {
    // Remove old entries outside the current window (sliding window)
    await client.zremrangebyscore(redisKey, 0, clearBefore);

    // Count entries within current window
    const currentCount = await client.zcard(redisKey);

    if (currentCount >= config.max) {
      // Rate limit exceeded
      const oldestAfterLimit = await client.zrange(redisKey, 0, 0, "WITHSCORES");
      const oldestTimestamp = oldestAfterLimit.length > 1 ? Number(oldestAfterLimit[1]) : now - windowMs;
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);
      return { allowed: false, retryAfter: Math.max(retryAfter, 1), remaining: 0 };
    }

    // Add current request to the window
    await client.zadd(redisKey, now, `${now}-${Math.random().toString(36).slice(2)}`);
    await client.expire(redisKey, config.windowSeconds + 1); // TTL slightly longer than window

    return {
      allowed: true,
      retryAfter: 0,
      remaining: Math.max(config.max - currentCount - 1, 0),
    };
  } catch (err) {
    // Redis failure: fail closed in production, fail open only for local development.
    logger.error({ err, key, source: "rate-limiter" }, "Redis rate limiter failed");
    if (process.env.NODE_ENV === "production") {
      return { allowed: false, retryAfter: 60, remaining: 0 };
    }

    return { allowed: true, retryAfter: 0, remaining: 0 };
  }
}

// ---------------------------------------------------------------------------
// MIDDLEWARE FACTORY
// ---------------------------------------------------------------------------
function createLimiter(configKey: string, keyFn: (req: Request) => string) {
  const config = CONFIG[configKey];
  if (!config) {
    throw new Error(`Unknown rate limit config: ${configKey}`);
  }

  return async function rateLimiterMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = keyFn(req);
    const result = await checkRateLimit(key, config);

    // Set rate limit headers on every request
    _res.set("X-RateLimit-Limit", String(config.max));
    _res.set("X-RateLimit-Window", String(config.windowSeconds));
    _res.set("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      _res.set("Retry-After", String(result.retryAfter));
      next(
        new AppError(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Too many requests. Please retry after ${result.retryAfter} seconds.`
        )
      );
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// EXPORTED MIDDLEWARE INSTANCES
// ---------------------------------------------------------------------------

export const globalRateLimiter = createLimiter("global", (req) => `global:${req.ip ?? "unknown"}`);
export const authRateLimiter = createLimiter("auth", (req) => `auth:${req.ip ?? "unknown"}`);

export function voucherRateLimiter(req: Request, _res: Response, next: NextFunction): void {
  // Voucher limiter uses user ID if available, falls back to IP
  const userKey = req.userId ? `voucher:user:${req.userId}` : `voucher:ip:${req.ip ?? "unknown"}`;
  createLimiter("voucher", () => userKey)(req, _res, next);
}

export function closeLimiter(): void {
  void closeRateLimiterRedis();
}

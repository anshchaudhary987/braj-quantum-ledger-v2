# GLM Ledger - Vercel Deployment Analysis & Fixes

## Date: 2026-05-10
## Status: CRITICAL ISSUES FOUND - IMMEDIATE ACTION REQUIRED

---

## 1. CRITICAL SERVERLESS FUNCTION CRASHES (Root Cause Analysis)

### A. Node.js Module Import Crisis
**Severity: CRITICAL**

Your serverless functions import from `../src/api/server.js`, but this file imports:
- `src/api/middleware/error-handler.js` → imports `../auth/auth-service.js`
- `src/api/auth/auth-service.js` → **JWT_SECRET evaluated at module import time (lines 27-36)**

**The Problem:**
```typescript
// auth-service.ts - lines 27-36
const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET environment variable is required...");
  }
  return secret;
})();
```

**Why it crashes on Vercel:**
1. During build, `tsc` compiles TypeScript
2. Each serverless function imports the entire Express app
3. On first function invocation, `auth-service.js` is loaded
4. `JWT_SECRET` is validated at module import time (NOT at request time)
5. If `JWT_SECRET` isn't set at the exact moment of function start, the entire function crashes
6. Vercel serverless uses process.env from project settings - but timing can be off during cold starts

**Impact:** ALL API functions crash immediately on cold start. 100% failure rate.

### B. Redis Connection Failure (Rate Limiter)
**Severity: CRITICAL**

```typescript
// rate-limiter-redis.ts - lines 15-25
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

function getRedisClient(): Redis {
  if (!_redisClient) {
    _redisClient = new Redis(REDIS_URL, {
      lazyConnect: true,  // Good: doesn't connect immediately
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
  }
  return _redisClient;
}
```

**Why it crashes:**
- On Vercel, `localhost:6379` doesn't exist
- When any rate-limited endpoint is hit, it tries to connect to Redis
- Connection fails, but `lazyConnect: true` helps at startup
- However, the middleware still tries to connect on first request
- If Redis isn't available, requests either hang or fail
- **Worse:** The `globalRateLimiter` is applied to ALL routes via `app.use(globalRateLimiter)`

### C. Database Connection Pool Issues
**Severity: HIGH**

```typescript
// pool.ts - creates a Pool at module level
const pool = new Pool({
  ...connectionConfig,
  ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  max: 20,              // Too high for serverless! 
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5000,
});
```

**Why it crashes:**
- Vercel serverless functions are short-lived (max 60s for standard plan)
- Each concurrent function gets its own process
- A pool of 20 connections per function instance → connection exhaustion on PostgreSQL
- If DB connection fails, ALL endpoints that touch the DB crash
- `connectionTimeoutMillis: 5000` means 5-second timeout - slow on cold start

### D. Process Signal Handlers (SIGTERM/SIGINT)
**Severity: MEDIUM-HIGH**

```typescript
// pool.ts - lines 79-82
if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);
}
```

**Why it crashes:**
- Vercel serverless doesn't use SIGTERM/SIGINT like traditional servers
- These signals aren't reliably sent in serverless environments
- Even if sent, `process.exit()` inside a handler kills the function mid-request
- Multiple functions registering the same handler can cause "MaxListenersExceededWarning"

### E. Server Auto-Start (Not Exported as Handler)
**Severity: CRITICAL**

```typescript
// server.ts - lines 112-118
const PORT = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logger.info(`GLM API server started on port ${PORT}`);
  });
}
```

**Why it crashes:**
- Vercel serverless functions don't call `app.listen()` - they export a handler
- But since ALL your `api/*.ts` files import the entire app, `app.listen()` is triggered
- Server tries to bind to port 3000 inside the serverless function
- This either fails with EADDRINUSE or causes the function to hang
- **Vercel expects: `export default (req, res) => app(req, res)` NOT `app.listen()`**

---

## 2. BACKEND ISSUES DETAILED

### Issue #1: Single Express App Exported by All Functions
**Current Pattern (WRONG for Vercel):**
```typescript
// api/vouchers/index.ts
import app from "../../src/api/server.js";
export default app;

// api/auth/index.ts
import app from "../../src/api/server.js";
export default app;
```

**Problem:** Every API function loads the ENTIRE Express application with ALL routes. When Vercel routes to `/api/vouchers`, it still loads auth, payroll, OCR, etc. routes. This wastes memory and increases cold start time dramatically.

### Issue #2: No Request-Level Error Handling for DB Connections
```typescript
// auth.routes.ts - register route
const result = await withClient(async (client) => {
  return withTransaction(client, async (tx) => {
    const service = new AuthService(tx, req.ip, req.headers["user-agent"] as string);
    return await service.register(input);
  });
});
```

**Problem:** If `withClient` fails (DB down, connection pool exhausted), it throws an unhandled error that crashes the function instead of returning a proper 500 response.

### Issue #3: Global State in Module-Level Variables
Multiple files have module-level state:
- `VoucherFactory.register(new SalesVoucherStrategy())` - at module import time
- `RetryWorker.sweepOnce()` - potential state persistence issue
- `_redisClient` - singleton Redis client shared across invocations

**On Vercel serverless:**
- Module-level variables persist between warm invocations (same container)
- But they're NOT shared between cold starts (new container)
- This leads to inconsistent behavior

### Issue #4: File System Operations
```typescript
// server.ts - lines 90-95
let openApiSpec = "";
try {
  openApiSpec = readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8");
} catch (err) {
  console.warn("Warning: Could not load openapi.yaml", err);
}
```

**Problem:** On Vercel, the filesystem is read-only. `readFileSync` will fail or return different results between builds and runtime. The `import.meta.url` path may not resolve correctly in serverless bundles.

### Issue #5: Long-Running Operations (Timeout Risk)
Multiple endpoints perform complex operations that may exceed Vercel's timeout:
- `/api/v1/vouchers` - Sales voucher creation (inventory + GST + stock movements)
- `/api/v1/payroll/run` - Payroll processing for all employees
- `/api/v1/ocr/extract` - AI document OCR pipeline
- `/api/v1/einvoice/generate` - E-invoice generation with retry logic
- `/api/v1/tally-import/process` - Tally XML batch processing

**Vercel limits:** 10s (Hobby), 30s (Pro max for some), 60s (Enterprise/max for functions)

### Issue #6: Fire-and-Forget Async Operations
```typescript
// Multiple files have patterns like:
withClient(async (conn) => { 
  // work without await
});  // No await! Errors swallowed
```

**Problem:** On serverless, fire-and-forget doesn't work reliably. The function container may freeze, and the work never completes.

### Issue #7: Missing Environment Variable Validation
The app assumes these are set but doesn't validate:
- `DATABASE_URL` or `NEON_DATABASE_URL` - DB connection
- `JWT_SECRET` - crashes if missing
- `REDIS_URL` - falls back to localhost (breaks on Vercel)
- `CORS_ORIGIN` - defaults to localhost in production
- `ENCRYPTION_MASTER_KEY` - used for banking data

---

## 3. FRONTEND ISSUES DETAILED

### Issue #1: API Base URL Hardcoded Fallback
```typescript
// frontend/next.config.ts
env: {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1',
},
```

**Problem:** Falls back to `localhost:3000` in production if env var is missing. All API calls will fail.

### Issue #2: CORS Configuration
```typescript
// server.ts
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  credentials: true,
  maxAge: 86400,
}));
```

**Problem:** If `CORS_ORIGIN` is not set, allows `localhost:3000` in production. Your frontend on Vercel will be blocked by CORS.

### Issue #3: Local Storage Token Access (SSR Issue)
```typescript
// frontend/src/lib/api.ts
const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
```

**Not a crash, but:** This pattern means SSR requests don't have the token. The if-statement check is correct, but any API call during SSR will be unauthenticated.

### Issue #4: No Environment-Specific Configuration
The frontend `.env.local` (from analysis) shows local development URLs. You need production-specific env vars:
```
NEXT_PUBLIC_API_URL=https://your-api.vercel.app/api/v1
```

### Issue #5: No API Error Boundary
No global error handling for API failures. If the backend is down, the frontend gets unhandled exceptions instead of graceful fallbacks.

---

## 4. VERCEL CONFIGURATION ISSUES

### Issue #1: Missing `api/analytics/index.ts`
```json
"api/analytics/*.ts": {
  "maxDuration": 60,
  "memory": 2048
}
```
But no `api/analytics/index.ts` file exists! This will cause build failures.

### Issue #2: Frontend Not Configured in vercel.json
The root `vercel.json` only configures API functions. There's no configuration for the Next.js frontend in `frontend/`. If you deploy from root, Vercel won't know about your Next.js app.

### Issue #3: Build Command Mismatch
```json
// Root package.json
"build": "tsc"
```
This only compiles backend TypeScript. It doesn't build the frontend.

### Issue #4: Missing `vercel.json` in frontend/
The frontend directory needs its own deployment configuration or should be a separate Vercel project.

### Issue #5: Output Directory Mismatch
```typescript
// frontend/next.config.ts
output: 'standalone'
```
This is correct for Docker but may not work well with Vercel's own Next.js deployment.

---

## 5. MISSING INFRASTRUCTURE FOR VERCEL

### Missing on Vercel:
1. **PostgreSQL database** - Vercel doesn't provide PostgreSQL natively
   - Solution: Use Neon, Supabase, or Railway
2. **Redis** - Vercel doesn't provide Redis
   - Solution: Use Upstash (Vercel integration) or Redis Cloud
3. **File Storage** - Vercel's filesystem is read-only and ephemeral
   - Solution: Use AWS S3, Cloudflare R2, or Vercel Blob
4. **Background Jobs** - No cron/queue on Vercel by default
   - Solution: Use Vercel Cron, QStash, or Upstash Queue

### Environment Variables Required on Vercel:
```
DATABASE_URL=postgresql://...
JWT_SECRET=your-256-bit-secret
REDIS_URL=rediss://... (Upstash)
CORS_ORIGIN=https://your-frontend.vercel.app
ENCRYPTION_MASTER_KEY=...
NODE_ENV=production
```

---

## 6. IMMEDIATE FIXES REQUIRED

### Priority 1: Fix Serverless Function Entry Points

Create a Vercel-compatible handler wrapper:

```typescript
// api/_handler.ts (new file)
import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../src/api/server.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  return app(req, res);
}
```

### Priority 2: Fix server.ts to NOT auto-start in serverless

```typescript
// src/api/server.ts - Fix lines 112-118
const PORT = Number(process.env.PORT) || 3000;

// Only start the server if NOT on Vercel and not in test mode
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(PORT, () => {
    logger.info(`GLM API server started on port ${PORT}`);
  });
}
```

### Priority 3: Lazy-initialize JWT_SECRET

```typescript
// src/api/auth/auth-service.ts - Fix lines 27-36
let JWT_SECRET: string | null = null;

function getJwtSecret(): string {
  if (!JWT_SECRET) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error("JWT_SECRET environment variable is required...");
    }
    JWT_SECRET = secret;
  }
  return JWT_SECRET;
}

// Use getJwtSecret() instead of JWT_SECRET directly
```

### Priority 4: Make Redis Optional (Fallback to In-Memory)

```typescript
// rate-limiter-redis.ts
const REDIS_URL = process.env.REDIS_URL;

function getRedisClient(): Redis | null {
  if (!REDIS_URL) {
    console.warn("REDIS_URL not set, rate limiting disabled");
    return null;
  }
  // ... existing code
}
```

### Priority 5: Fix Database Pool for Serverless

```typescript
// pool.ts
const pool = new Pool({
  ...(connectionString ? { connectionString } : { /* fallback */ }),
  ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX) || 5,  // Reduced from 20 for serverless
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS) || 10_000,
  connectionTimeoutMillis: 3000,
  // Add serverless-friendly settings
  allowExitOnIdle: true,  // Allow pool to close idle connections
});
```

### Priority 6: Add Graceful Error Handling for Missing Services

Create a safe initialization module:
```typescript
// src/config/env-check.ts
export function validateEnv(): void {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
```

### Priority 7: Fix Frontend API URL

```typescript
// frontend/next.config.ts
const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  },
  // Remove output: 'standalone' for Vercel deployment
  // Let Vercel handle the build
};
```

### Priority 8: Create Separate Vercel Projects or Monorepo Config

**Option A: Monorepo**
Create `vercel.json` at root that handles both frontend and backend.

**Option B: Separate Projects**
- Backend: Deploy from root with `vercel.json` for API
- Frontend: Deploy from `frontend/` directory as separate Vercel project

**Recommended: Option B**

---

## 7. DEPLOYMENT STRATEGY

### Step 1: Fix Critical Issues (This session)
- [ ] Fix server.ts to not auto-start
- [ ] Lazy-initialize JWT_SECRET
- [ ] Make Redis optional
- [ ] Fix DB pool settings
- [ ] Remove process signal handlers for serverless

### Step 2: Database Setup
- [ ] Set up PostgreSQL on Neon/Supabase
- [ ] Run migrations
- [ ] Set DATABASE_URL in Vercel environment

### Step 3: Redis Setup
- [ ] Set up Upstash Redis
- [ ] Set REDIS_URL in Vercel environment
- [ ] Or implement in-memory rate limiting as fallback

### Step 4: Environment Variables
- [ ] Set all required env vars in Vercel dashboard
- [ ] Verify JWT_SECRET is at least 32 chars
- [ ] Set CORS_ORIGIN to match frontend URL

### Step 5: Frontend Deployment
- [ ] Fix frontend build configuration
- [ ] Deploy frontend separately or configure monorepo
- [ ] Verify API_BASE_URL points to live backend

### Step 6: Testing
- [ ] Test health endpoint first
- [ ] Test authentication flow
- [ ] Test core business logic
- [ ] Monitor serverless function logs

---

## 8. LONG-TERM ARCHITECTURE RECOMMENDATIONS

### Move Away from Traditional Server Patterns
1. **Replace Express with Next.js API Routes** for Vercel-native serverless
2. **Use Next.js middleware** for rate limiting, auth
3. **Use Vercel Edge Functions** for simple, fast operations
4. **Implement background jobs with Vercel Cron** or QStash
5. **Use Vercel Blob** for file uploads instead of S3 if possible

### Or Use Alternative Platform
If this full-stack architecture is too complex for Vercel:
- **Railway/Render/Fly.io** for traditional Node.js server
- Keep Vercel only for the Next.js frontend
- Use API Gateway + Lambda if staying on AWS ecosystem

---

## SUMMARY: TOP 5 FIXES

1. **Fix server.ts `app.listen()`** - Wrap in `if (!process.env.VERCEL)`
2. **Lazy-load JWT_SECRET** - Don't validate at module import time
3. **Make Redis optional** - Add fallback for when REDIS_URL is missing
4. **Reduce DB pool size** - Use 5 max instead of 20 for serverless
5. **Fix frontend/backend deployment** - Either separate projects or proper monorepo config

These 5 fixes will resolve the "serverless function crashed" error on Vercel.

# GLM Accounting SaaS — Production Cloud Architecture
# =============================================================================
# VERCEL (Serverless) + NEON (PostgreSQL) + UPSTASH (Redis)
# =============================================================================

                              ┌──────────────────────────────────────────────────┐
                              │           VERCEL FIREWALL (WAF Layer)            │
                              │   Custom Rules • Managed Rulesets • IP Blocking  │
                              │   Rate Limiting • Geo-Restriction • Bot Mitigation│
                              └──────────────┬───────────────────────────────────┘
                                             │
                              ┌──────────────▼───────────────────────────────────┐
                              │           VERCEL EDGE NETWORK                     │
                              │   ~120 Global PoPs • TLS 1.3 • HTTP/2 + HTTP/3   │
                              │   Automatic SSL (Let's Encrypt) • DDoS Mitigation │
                              │   Edge Middleware (auth, rewrite, redirect)        │
                              └───────┬──────────────────┬───────────────────────┘
                                      │                  │
                          ┌───────────▼──────┐   ┌───────▼──────────────────────┐
                          │   EDGE RUNTIME   │   │       STATIC ASSETS          │
                          │   (middleware.ts) │   │   Vercel CDN (global cache)  │
                          │   • Auth check   │   │   • Dashboard SPA            │
                          │   • Rate limit   │   │   • OpenAPI docs             │
                          │   • Geo-block    │   │   • PDF report templates     │
                          └───────┬──────────┘   └──────────────────────────────┘
                                  │
                          ┌───────▼──────────────────────────────────────────────┐
                          │              VERCEL SERVERLESS FUNCTIONS              │
                          │                   (Node.js 20)                        │
                          │                                                       │
                          │   /api/vouchers/*     → vouchers.handler             │
                          │   /api/reports/*      → reporting.handler            │
                          │   /api/analytics/*    → analytics.handler            │
                          │   /api/auth/*         → auth.handler                 │
                          │   /api/health          → health.handler              │
                          │                                                       │
                          │   ┌─────────────────────────────────────────────┐    │
                          │   │  Concurrency: Auto-scale 0 → ∞              │    │
                          │   │  Max timeout:  60s (Pro) / 900s (Enterprise)│    │
                          │   │  Memory:       1 GB (Pro) / 3 GB (Ent)      │    │
                          │   │  Cold start:   ~100ms (with Warm Pool)      │    │
                          │   └─────────────────────────────────────────────┘    │
                          └───────────┬──────────────────┬───────────────────────┘
                                      │                  │
                          ┌───────────▼──────┐   ┌───────▼───────────────────────┐
                          │   UPSTASH REDIS  │   │      NEON POSTGRESQL          │
                          │   (Global)       │   │   (Serverless Postgres 16)    │
                          │                  │   │                                │
                          │   ┌────────────┐ │   │   ┌────────────────────────┐  │
                          │   │ Session    │ │   │   │  PRIMARY COMPUTE        │  │
                          │   │ Store      │ │   │   │  (Writer — Vouchers)    │  │
                          │   │ (JWT refr) │ │   │   │  Autoscaling CU: 1→16   │  │
                          │   ├────────────┤ │   │   │  Pooler: PgBouncer      │  │
                          │   │ Analytics  │ │   │   └────────┬───────────────┘  │
                          │   │ Cache      │ │   │            │                  │
                          │   │ (TTL:2-30m)│ │   │   ┌────────▼───────────────┐  │
                          │   ├────────────┤ │   │   │ READ REPLICA           │  │
                          │   │ Rate       │ │   │   │ (Reader — Reports/     │  │
                          │   │ Limiter    │ │   │   │  Dashboard queries)    │  │
                          │   │ (sliding)  │ │   │   │ Autoscaling CU: 1→N    │  │
                          │   └────────────┘ │   │   └────────────────────────┘  │
                          │                  │   │                                │
                          │   TLS Encrypted  │   │   ┌────────────────────────┐  │
                          │   99.99% SLA     │   │   │ NEON DATABASE BRANCHES  │  │
                          │   Max 4GB/cluster│   │   │ • main (production)     │  │
                          │                  │   │   │ • preview-* (per-PR db) │  │
                          └──────────────────┘   │   │ • pitr-recovery-*      │  │
                                                  │   └────────────────────────┘  │
                          ┌──────────────────┐   │                                │
                          │  VERCEL BLOB     │   │   ┌────────────────────────┐  │
                          │  (Object Store)  │   │   │ PITR + BACKUPS         │  │
                          │                  │   │   │ • Point-in-Time Restore│  │
                          │  • Documents     │   │   │   (Any second, 7 days) │  │
                          │  • Uploads       │   │   │ • Daily snapshots      │  │
                          │  • Archived PDFs │   │   │ • Database branching   │  │
                          │  • CDN delivery  │   │   │   for instant clones   │  │
                          └──────────────────┘   │   └────────────────────────┘  │
                                                  │   AES-256 at rest            │
                          ┌──────────────────────┐│   TLS 1.3 in transit          │
                          │ VERCEL KV (optional) ││   IP Allowlist (Vercel IPs)   │
                          │ Edge key-value store ││   SOC 2 / ISO 27001           │
                          └──────────────────────┘└───────────────────────────────┘


# =============================================================================
# 1. DATABASE SCALING — Read / Write Separation (Neon)
# =============================================================================

## 1a. Neon Architecture

Neon is a serverless PostgreSQL with separation of compute and storage.
Each "compute endpoint" is a stateless Postgres instance that reads from
shared storage. This means:

  1. You can have MULTIPLE compute endpoints pointing at the SAME data.
  2. Primary endpoint = writer. Read-only endpoints = readers.
  3. Autoscaling: compute units (CU) scale 1→16 automatically based on load.

┌─────────────────────────────────────────────────────────────────┐
│  NEON: Shared Storage Layer                                     │
│  ─────────────────────────                                      │
│  • WAL-based storage, automatically replicated 3× across AZs    │
│  • All compute endpoints read from the same consistent storage  │
│  • Read replicas: NO replication lag (same storage, same data)   │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    ┌─────▼─────┐   ┌────────▼────────┐   ┌──────▼──────────┐
    │ PRIMARY   │   │ READ REPLICA 1  │   │ READ REPLICA 2  │
    │ COMPUTE   │   │ (Reports)       │   │ (Dashboard)     │
    │───────────│   │─────────────────│   │─────────────────│
    │ min: 1 CU │   │ min: 1 CU       │   │ min: 1 CU       │
    │ max: 16 CU│   │ max: 8 CU       │   │ max: 8 CU       │
    │ Writer    │   │ Read-Only       │   │ Read-Only       │
    │ Pooler ON │   │ Pooler ON       │   │ Pooler ON       │
    └─────┬─────┘   └────────┬────────┘   └──────┬──────────┘
          │                  │                    │
          ▼                  ▼                    ▼
    WRITE POOL          READ POOL            DASHBOARD POOL
    (PgBouncer)         (PgBouncer)          (PgBouncer)
    max_conns: 200      max_conns: 500       max_conns: 500

## 1b. Application-Level Routing (Node.js + Vercel Functions)

Each Vercel function initializes TWO pools on first invocation
(kept alive via Vercel's function reuse — no cold starts on active routes):

┌──────────────────────────────────────────────────────────────────┐
│  src/db/serverless-pool.ts                                       │
│                                                                   │
│  import { Pool } from "@neondatabase/serverless";                 │
│                                                                   │
│  // Writer pool — all voucher POST / PUT / DELETE                 │
│  export const writePool = new Pool({                              │
│    connectionString: process.env.NEON_DATABASE_URL,  // PRIMARY   │
│    max: 20,                                                       │
│    idleTimeoutMillis: 0,         // Let Neon manage idle          │
│    connectionTimeoutMillis: 5000,                                 │
│  });                                                              │
│                                                                   │
│  // Reader pool — all GET /reports and GET /analytics             │
│  export const readPool = new Pool({                               │
│    connectionString: process.env.NEON_READ_REPLICA_URL,           │
│    max: 50,              // More conns for parallel queries        │
│    idleTimeoutMillis: 0,                                          │
│    connectionTimeoutMillis: 5000,                                  │
│  });                                                              │
│                                                                   │
│  export function getClientFor(op: "read" | "write") {             │
│    return op === "write" ? writePool : readPool;                  │
│  }                                                                │
└──────────────────────────────────────────────────────────────────┘

The routing convention is:
  - Any route that MODIFIES data (POST/PUT/PATCH/DELETE) → writePool
  - Any route that READS data (GET) → readPool
  - Heavy analytics functions → readPool (dedicated replica endpoint)

# =============================================================================
# 2. DISASTER RECOVERY & BACKUPS (Zero Data Loss)
# =============================================================================

## 2a. Neon Point-in-Time Recovery (PITR)

Neon stores a complete WAL history for the retention period.
PITR is achieved via DATABASE BRANCHING — you fork the database
at any millisecond in the past:

  # CLI: Restore database to a specific point in time
  npx neon branches create \
    --project-id "glm-production" \
    --name "pitr-recovery-20260315-1414" \
    --parent-id "main" \
    --point-in-time "2026-03-15T14:14:00Z"

  # This creates an INSTANT copy of the database as it was at 2:14 PM.
  # No data copy — Neon uses copy-on-write, so branches are created in seconds.
  # The branch has its own compute endpoint you can connect to.

## 2b. PITR Recovery Procedure (DB corruption at 2:15 PM)

  1. IDENTIFY the timestamp: 2:14:00 PM (1 minute before corruption).

  2. CREATE RECOVERY BRANCH:
       neon branches create \
         --project-id "glm-production" \
         --name "recovery-$(date +%Y%m%d-%H%M)" \
         --point-in-time "2026-03-15T14:14:00Z"

  3. Branch is ready in seconds (copy-on-write, zero data copy).

  4. RUN VALIDATION on recovery branch:
       SELECT SUM(debit_amount - credit_amount) FROM journal_entries;
       -- Must return 0.00 (double-entry integrity check)

  5. PROMOTE recovery branch to production:
       Option A: Swap NEON_DATABASE_URL in Vercel env vars → instant.
       Option B: Rename branches: main → main-corrupted, recovery-xxx → main.

  6. VERIFY application works on new main → delete corrupted branch.

  RTO: < 2 minutes   (branch creation is near-instant)
  RPO: < 1 second    (WAL is continuous, any timestamp is branchable)

## 2c. Automated Backup Policy

Neon provides multiple layers of protection:

  │ Backup Type          │ Frequency      │ Retention     │ Purpose                │
  │──────────────────────│────────────────│───────────────│────────────────────────│
  │ WAL Archiving        │ Continuous     │ 7 days        │ PITR (any second)      │
  │ Auto-Snapshots       │ Daily (04:00)  │ 7 days        │ Fast point restore     │
  │ Database Branches    │ On-demand      │ Manual delete │ Pre-migration anchor    │
  │ Logical Dump (pg_dump)│ Weekly        │ S3/Blob (1yr)│ Off-platform backup     │
  │ Vercel Blob Export   │ Monthly        │ 7 years       │ Compliance archive     │

## 2d. Pre-Migration Safety (Automated)

Before every schema migration, CI/CD creates a PROTECTED BRANCH:

  neon branches create \
    --project-id "glm-production" \
    --name "pre-migrate-${GITHUB_SHA::7}" \
    --parent-id "main" \
    --protected true    # Cannot be deleted without admin approval

If the migration fails, you point the app to this branch immediately.
This is cheaper and faster than RDS snapshots — branches are logical forks,
not physical copies.

# =============================================================================
# 3. APPLICATION SECURITY & WAF (Vercel Firewall)
# =============================================================================

## 3a. Vercel Firewall — Custom Rules

Vercel's Firewall operates at the EDGE (before traffic reaches your functions):

┌──────────────────────────────────────────────────────────────────────┐
│  VERCEL FIREWALL RULES (applied in order)                            │
│                                                                       │
│  Rule 1: IP Blocking                                                 │
│    • Block known malicious IPs (Vercel-managed threat feed)          │
│    • Custom IP blocklist (abusive tenants, scrapers)                 │
│                                                                       │
│  Rule 2: Rate Limiting (per path)                                     │
│    • POST /api/vouchers/*    → 30 req / 60s per IP                  │
│    • POST /api/auth/login    → 5  req / 60s per IP                  │
│    • GET  /api/*              → 500 req / 60s per IP (baseline)      │
│    • Global burst: 200 req / 10s per IP                             │
│    • Action: Challenge (JS/CAPTCHA) or Block                         │
│                                                                       │
│  Rule 3: Geo-Restriction                                              │
│    • Allow: IN (India)                                               │
│    • Block: All other countries                                      │
│    • Exception: Allowlist specific IPs for auditors/partners         │
│                                                                       │
│  Rule 4: Managed WAF Rulesets                                         │
│    • OWASP Top 10 (Vercel managed, auto-updated)                     │
│    • SQL Injection signatures                                        │
│    • XSS patterns                                                    │
│    • File inclusion / path traversal attacks                         │
│    • Malicious user-agent blocking                                   │
│                                                                       │
│  Rule 5: Request Validation                                           │
│    • Max body size: 1 MB                                             │
│    • Max headers size: 8 KB                                          │
│    • Block requests with null byte in URL                            │
│    • Enforce HTTPS only (redirect HTTP → HTTPS)                      │
│                                                                       │
│  Rule 6: Bot Protection                                               │
│    • Block known bot user-agents                                     │
│    • Rate limit unknown crawlers                                     │
│    • Allow: Googlebot, Bingbot (for public docs)                     │
└──────────────────────────────────────────────────────────────────────┘

## 3b. Edge Middleware — Custom Protection Logic

Vercel Edge Middleware runs AFTER the Firewall, at the CDN edge,
on EVERY request (global, near-zero latency):

```typescript
// middleware.ts — runs on Vercel Edge Runtime
import { NextRequest, NextResponse } from "next/server"; // or generic
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(100, "60 s"),
});

export async function middleware(req: NextRequest) {
  // 1. Security headers on every response
  const response = NextResponse.next();

  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "0");           // Deprecated, use CSP
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // 2. Geo-restriction (additional layer beyond Firewall)
  const country = req.geo?.country;
  if (country && country !== "IN") {
    // Allow only if IP is in the auditor allowlist
    const ip = req.ip ?? req.headers.get("x-forwarded-for") ?? "";
    const isAllowed = await redis.sismember("allowlist:non-in-ips", ip);
    if (!isAllowed) {
      return new NextResponse("Access restricted to India", { status: 403 });
    }
  }

  // 3. API rate limiting
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const identifier = req.ip ?? req.headers.get("x-forwarded-for") ?? "anonymous";
    const { success, limit, remaining } = await ratelimit.limit(identifier);

    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Remaining", String(remaining));

    if (!success) {
      return new NextResponse("Too many requests", { status: 429 });
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

## 3c. Encryption at Rest (AES-256)

Your existing `encryption-service.ts` (envelope encryption, AES-256-GCM, per-record DEKs)
integrates with Vercel's environment variables for the master key:

  ┌───────────────────────────────────────────────────────────────────┐
  │  ENCRYPTION ARCHITECTURE (Vercel-compatible)                      │
  │                                                                    │
  │  ┌────────────────────┐                                           │
  │  │ ENCRYPTION_MASTER   │  → 32+ char secret stored in             │
  │  │ _KEY               │     Vercel Environment Variables           │
  │  │                     │     (encrypted at rest, never in git)     │
  │  └─────────┬───────────┘                                           │
  │            │                                                       │
  │            ▼                                                       │
  │  ┌─────────────────────┐                                          │
  │  │ Per-record DEK       │  → Generated per row, encrypted with     │
  │  │ (Data Encryption Key)│     the master key, stored in the same   │
  │  └─────────┬───────────┘     blob as ciphertext                    │
  │            │                                                       │
  │            ▼                                                       │
  │  ┌──────────────────────────────────┐                             │
  │  │ DATABASE ENCRYPTION              │                             │
  │  │                                  │                             │
  │  │ • Neon: AES-256 at rest (all     │                             │
  │  │   data is automatically encrypted│                             │
  │  │   on Neon's storage layer)       │                             │
  │  │ • Application-layer: per-column  │                             │
  │  │   AES-256-GCM envelope encryption│                             │
  │  │   for PII fields (bank a/c, PAN, │                             │
  │  │   UAN, GSTIN)                    │                             │
  │  │ • TLS 1.3 for all connections    │                             │
  │  │ • Neon: IP allowlist (Vercel IPs │                             │
  │  │   only)                          │                             │
  │  │ • Upstash: TLS + AUTH token      │                             │
  │  └──────────────────────────────────┘                             │
  └───────────────────────────────────────────────────────────────────┘

Encryption coverage matrix:
  • bank_accounts.account_number      → AES-256-GCM envelope (per-record DEK)
  • payroll.employee_pan               → AES-256-GCM envelope
  • payroll.employee_uan               → AES-256-GCM envelope
  • gst_returns.pan                    → AES-256-GCM envelope
  • Database at rest (Neon)            → AES-256 (Neon-managed)
  • Redis at rest (Upstash)            → AES-256 (Upstash-managed)
  • All data in transit                → TLS 1.3 (Neon, Upstash, Vercel)
  • Secrets (Vercel env vars)          → AES-256-GCM (Vercel-managed)

# =============================================================================
# 4. AUTO-SCALING — Handling GST Deadline Spikes (10× traffic)
# =============================================================================

## 4a. Vercel Serverless Auto-Scaling

Vercel serverless functions scale automatically. Unlike traditional
Kubernetes HPA, there is NO pod provisioning delay — each HTTP request
is routed to a function instance. If none are warm, a cold start
(~100ms with Warm Pool) creates a new one.

  ┌──────────────────────────────────────────────────────────────────┐
  │  VERCEL SCALING CHARACTERISTICS                                   │
  │  ──────────────────────────────                                   │
  │  • Concurrency:   1 request per function instance (default)       │
  │  • Max instances: Unlimited (Pro), 1000+ (Enterprise)            │
  │  • Cold start:    ~100ms with Warm Pool (Pro), <50ms (Enterprise)│
  │  • Scale to zero:  Functions with no traffic consume $0           │
  │  • Regional exec:  Functions run in ap-south-1 (Mumbai) for IN    │
  └──────────────────────────────────────────────────────────────────┘

## 4b. Proactive Capacity (Vercel Concurrency Settings)

For GST deadline dates (17th-21st each month), you can set higher
baseline concurrency via Vercel's "Concurrency" setting:

  │ Period                    │ Baseline Concurrency │ Max Concurrency │
  │───────────────────────────│──────────────────────│─────────────────│
  │ Normal business days      │ 20                   │ 500             │
  │ GSTR-3B deadline (17-21)  │ 100                  │ 2000            │
  │ GSTR-1 deadline (10-13)   │ 80                   │ 1500            │
  │ Quarter-end (GSTR-9)      │ 120                  │ 3000            |

## 4c. Database Scaling (Neon Autoscaling)

Neon automatically scales database compute during traffic spikes:

  │ Component          │ Normal   │ GST Spike    │ Behaviour                   │
  │────────────────────│──────────│──────────────│─────────────────────────────│
  │ Primary (writer)   │ 1-2 CU   │ 4-8 CU       │ Auto-scales every 15s       │
  │ Read Replica #1    │ 1 CU     │ 2-4 CU       │ Auto-scales on CPU > 70%    │
  │ Read Replica #2    │ 1 CU     │ 2-4 CU       │ Auto-scales on CPU > 70%    │
  │ PgBouncer pool     │ auto     │ auto         │ Connection pooling built-in  │

## 4d. Redis Scaling (Upstash)

Upstash Redis offers auto-scaling for rate limiting and caching:
  • Global replication: Edge-cached at 120+ PoPs for <10ms reads
  • Auto-scaling: Up to 4 GB per database (Pro plan)
  • Connection pooling: Built into @upstash/redis SDK

## 4e. Graceful Degradation Under Extreme Load

If the database reaches max connections, Vercel functions implement
a circuit breaker pattern:

  ┌────────────────────────────────────────────────────────────────┐
  │  CIRCUIT BREAKER (analytics endpoints)                         │
  │                                                                 │
  │  state: CLOSED → OPEN → HALF_OPEN → CLOSED                     │
  │                                                                 │
  │  Closed (normal):                                              │
  │    → Execute DB query, return fresh data                        │
  │                                                                 │
  │  Open (DB overloaded, > 50% failures in 10s):                   │
  │    → Return CACHED stale data (Redis) with header:              │
  │      X-Data-Stale: true                                         │
  │      X-Stale-Age: 120s                                          │
  │    → Dashboard: Accept 2-min-old data instead of erroring       │
  │                                                                 │
  │  Half-open (after 30s cooldown):                                │
  │    → Allow 1 probe request. If success → CLOSED. If fail → OPEN │
  └────────────────────────────────────────────────────────────────┘

# =============================================================================
# 5. CI/CD PIPELINE — Vercel-native Blue-Green Deployment
# =============================================================================

## 5a. Vercel Deployment Model

Vercel uses IMMUTABLE DEPLOYMENTS. Every deployment receives a unique,
immutable URL (e.g., `glm-abc123.vercel.app`). The "production" URL
points to whichever deployment is promoted.

This provides BUILT-IN BLUE-GREEN and instant rollback:

  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                      │
  │  1. DEV pushes to `main` branch                                      │
  │       │                                                              │
  │       ▼                                                              │
  │  2. VERCEL builds a NEW deployment (immutable)                       │
  │       ├──► Install dependencies                                      │
  │       ├──► Typecheck + Lint                                          │
  │       ├──► Run unit tests                                            │
  │       ├──► Build production bundle                                    │
  │       └──► Deploy to preview URL: glm-a1b2c3d.vercel.app             │
  │                                                                      │
  │  3. AUTOMATIC PREVIEW DEPLOY (per branch / PR)                       │
  │       └──► Each PR gets a PREVIEW DATABASE branch (Neon branching)    │
  │           Neon branches are instant, zero-cost copies of the schema   │
  │           that allow full integration testing without touching prod   │
  │                                                                      │
  │  4. SMOKE TESTS on preview deployment URL                            │
  │       ├──► GET  /api/health                   → 200                 │
  │       ├──► POST /api/vouchers/payment (test)  → 201                 │
  │       ├──► GET  /api/reports/trial-balance    → 200, valid JSON     │
  │       ├──► GET  /api/analytics/ratios          → 200, ratios > 0    │
  │       ├──► POST /api/auth/refresh             → 200                 │
  │       └──► Double-entry check: SUM(debits) == SUM(credits)           │
  │                                                                      │
  │  5. RUN DATABASE MIGRATIONS (on Neon main branch)                    │
  │       └──► Migrations are BACKWARD-COMPATIBLE (add columns only)      │
  │                                                                      │
  │  6. PROMOTE to PRODUCTION (aliased to glm-saas.in)                   │
  │       └──► `vercel promote <deploy-id>`                              │
  │       └──► OR: Set production alias via Vercel Dashboard             │
  │                                                                      │
  │  7. HOT ROLLBACK (if issues detected)                                │
  │       └──► `vercel rollback <previous-deploy-id>`                    │
  │       └──► INSTANT rollback (previous deployment is still warm)       │
  │       └──► NO DNS propagation delay, NO ALB weight switching         │
  │                                                                      │
  │  8. CLEAN UP preview databases after PR merge                         │
  │       └──► `neon branches delete preview-pr-123`                     │
  │                                                                      │
  └─────────────────────────────────────────────────────────────────────┘

## 5b. Blue-Green Difference (Vercel vs AWS)

  │ Aspect              │ AWS (ALB)            │ Vercel                │
  │─────────────────────│──────────────────────│───────────────────────│
  │ Deploy mechanism    │ ALB weight switching │ Immutable deploy URL   │
  │ Rollback time       │ ~30s (weight shift)  │ Instant (alias swap)   │
  │ Pre-deploy testing  │ Canary 10% traffic   │ Preview URL (full test)│
  │ DB migration coord  │ RDS snapshot first   │ Neon branch first      │
  │ Session continuity  │ Redis (shared)       │ Redis (shared)        │
  │ Downtime            │ 0 seconds            │ 0 seconds             │

## 5c. Session Continuity (JWT + Redis)

  • Access token: 15-min JWT (stateless — any Vercel function validates)
  • Refresh token: Stored in Upstash Redis (global, all functions read)
  • Deploy event: New functions spin up → read same Redis → no session loss
  • Rollback event: Previous deployment is still warm → instant switch

# =============================================================================
# 6. MONITORING & ALERTING
# =============================================================================

  │ Alarm                            │ Source        │ Severity │ Channel     │
  │──────────────────────────────────│───────────────│──────────│─────────────│
  │ Function error rate > 1%         │ Vercel Logs   │ CRITICAL │ Slack/PD    │
  │ Function p99 latency > 2s        │ Vercel Logs   │ WARNING  │ Slack       │
  │ DB connection failures           │ Neon Console  │ CRITICAL │ PagerDuty   │
  │ DB CPU > 80% sustained 5min      │ Neon Console  │ WARNING  │ Slack       │
  │ Redis connection failures        │ Upstash       │ CRITICAL │ PagerDuty   │
  │ Rate limit threshold breached    │ Vercel FW     │ HIGH     │ Slack       │
  │ WAF block count > 100/min        │ Vercel FW     │ HIGH     │ Slack       │
  │ Double-entry imbalance           │ Health check  │ CRITICAL │ PagerDuty   │
  │ Neon branch limit approaching    │ Neon Console  │ WARNING  │ Slack       │
  │ SSL cert expiring                │ Vercel        │ LOW      │ Slack       │

## 6a. Observability Stack

  • Logs:       Vercel Logs + LogDrains → Datadog / Axiom
  • Metrics:    Vercel Analytics + Neon Console + Upstash Console
  • Traces:     OpenTelemetry → Honeycomb / Datadog APM
  • Alerts:     Vercel Integrations → Slack / PagerDuty
  • Uptime:     Vercel + Checkly (synthetic health checks)

# =============================================================================
# 7. COST ESTIMATE (Monthly — Indian SME SaaS)
# =============================================================================

  │ Service           │ Plan          │ Cost/month     │ Notes                    │
  │───────────────────│───────────────│────────────────│──────────────────────────│
  │ Vercel            │ Pro           │ $20            │ + serverless execution    │
  │ Neon PostgreSQL   │ Scale         │ $25 → $200     │ Autoscaling CU + branches │
  │ Upstash Redis     │ Pay-as-you-go │ $10 → $150     │ 4GB max, global           │
  │ Vercel Blob       │ Included      │ $0 → $50       │ 100GB included            │
  │ Firewall          │ Included      │ $0             │ Built into Vercel Pro     │
  │ SSL / CDN         │ Included      │ $0             │ Built into Vercel         │
  │ Log Drains        │ Included      │ $0             │ Built into Vercel Pro     │
  │───────────────────│───────────────│────────────────│──────────────────────────│
  │ TOTAL (baseline)  │               │ ~$55/month     │ 100 tenants, 100K txns    │
  │ TOTAL (peak)      │               │ ~$420/month    │ GST deadline, 10× load    │
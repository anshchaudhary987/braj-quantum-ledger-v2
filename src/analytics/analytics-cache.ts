// ============================================================================
// ANALYTICS CACHE — Redis-backed dashboard caching with event-driven invalidation
// ============================================================================
// Architecture:
//   Tier 1 — Redis (hot cache): Dashboard API responses with TTL + stale-while-revalidate.
//   Tier 2 — PostgreSQL Materialized Views: Pre-computed heavy aggregates, refreshed
//            on write events or via pg_cron on a schedule.
//
// Invalidation Strategy:
//   - Journal entries posted/voided → invalidate cash_flow, ratios, executive_dashboard.
//   - Stock movements (IN/OUT) → invalidate inventory_aging, ratios, executive_dashboard.
//   - Bank reconciliation → invalidate cash_flow, executive_dashboard.
//   - Smart invalidation: only invalidate if the posted entry touches relevant accounts.
//   - TTL-based expiry as safety net for missed events.
// ============================================================================

import { EventEmitter } from "events";
import {
  ReportType,
  CacheConfig,
  CacheEnvelope,
  AnalyticsEventType,
  InvalidationPayload,
} from "./analytics-types";

// ---------------------------------------------------------------------------
// REDIS CLIENT ABSTRACTION — Swap with ioredis or node-redis in production
// ---------------------------------------------------------------------------

interface RedisClient {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<void>;
  del(...keys: string[]): Promise<number>;
  pipeline(): Pipeline;
  scan(
    cursor: string,
    match: string,
    count: number
  ): Promise<[string, string[]]>;
}

interface Pipeline {
  del(...keys: string[]): Pipeline;
  exec(): Promise<void>;
}

// ---------------------------------------------------------------------------
// IN-MEMORY FALLBACK — For development without a Redis server
// ---------------------------------------------------------------------------

class InMemoryRedis implements RedisClient {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  pipeline(): Pipeline {
    const keysToDelete: string[] = [];
    const parent = this;
    return {
      del(...keys: string[]): Pipeline {
        keysToDelete.push(...keys);
        return this;
      },
      async exec(): Promise<void> {
        for (const key of keysToDelete) {
          parent.store.delete(key);
        }
      },
    };
  }

  async scan(
    cursor: string,
    match: string,
    count: number
  ): Promise<[string, string[]]> {
    const pattern = match.replace(/\*/g, ".*");
    const regex = new RegExp(`^${pattern}$`);
    const allKeys = Array.from(this.store.keys());
    const matched = allKeys.filter((k) => regex.test(k));
    const start = parseInt(cursor, 10) || 0;
    const slice = matched.slice(start, start + count);
    const nextCursor = start + slice.length >= matched.length ? "0" : String(start + slice.length);
    return [nextCursor, slice];
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// CACHE CONFIGURATION
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_CONFIG: Record<ReportType, CacheConfig> = {
  cash_flow:               { ttl: 900,  staleWhileRevalidate: true, refreshThreshold: 0.85 },
  ratios:                  { ttl: 300,  staleWhileRevalidate: true, refreshThreshold: 0.80 },
  inventory_aging:         { ttl: 1800, staleWhileRevalidate: true, refreshThreshold: 0.90 },
  inventory_aging_summary: { ttl: 1800, staleWhileRevalidate: true, refreshThreshold: 0.90 },
  executive_dashboard:     { ttl: 120,  staleWhileRevalidate: true, refreshThreshold: 0.70 },
};

// ---------------------------------------------------------------------------
// INVALIDATION MAP — which report types to invalidate per event
// ---------------------------------------------------------------------------

const INVALIDATION_MAP: Record<AnalyticsEventType, ReportType[]> = {
  [AnalyticsEventType.JOURNAL_POSTED]:       ["cash_flow", "ratios", "executive_dashboard"],
  [AnalyticsEventType.JOURNAL_VOIDED]:       ["cash_flow", "ratios", "executive_dashboard"],
  [AnalyticsEventType.STOCK_MOVEMENT]:       ["inventory_aging", "inventory_aging_summary", "ratios", "executive_dashboard"],
  [AnalyticsEventType.BANK_RECONCILIATION]:  ["cash_flow", "executive_dashboard"],
  [AnalyticsEventType.PERIOD_CLOSED]:        ["cash_flow", "ratios", "inventory_aging", "inventory_aging_summary", "executive_dashboard"],
};

// ---------------------------------------------------------------------------
// CACHE KEY BUILDER — deterministic, prefixed, scan-friendly
// ---------------------------------------------------------------------------

function buildCacheKey(tenantId: string, reportType: string, paramsHash: string): string {
  return `analytics:${tenantId}:${reportType}:${paramsHash}`;
}

function buildParamsHash(params: Record<string, string>): string {
  // Deterministic hash: sort keys, join with '=', concatenate with '|'
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("|");
}

// ---------------------------------------------------------------------------
// ANALYTICS CACHE SERVICE
// ---------------------------------------------------------------------------

export class AnalyticsCache {
  private redis: RedisClient;
  private events: EventEmitter;

  constructor(redisClient?: RedisClient) {
    this.redis = redisClient ?? new InMemoryRedis();
    this.events = new EventEmitter();
    this.registerInvalidationHandlers();
  }

  // -------------------------------------------------------------------
  // PUBLIC: getOrCompute — cache-aside with stale-while-revalidate
  // -------------------------------------------------------------------

  async getOrCompute<T>(
    tenantId: string,
    reportType: ReportType,
    params: Record<string, string>,
    computeFn: () => Promise<T>
  ): Promise<T> {
    const cacheKey = buildCacheKey(tenantId, reportType, buildParamsHash(params));
    const config = DEFAULT_CACHE_CONFIG[reportType];

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const envelope: CacheEnvelope<T> = JSON.parse(cached);
      const ttlRemaining = envelope.expiresAt - Date.now();

      // If nearing expiry, serve stale and refresh in background
      if (ttlRemaining < config.ttl * (1 - config.refreshThreshold) * 1000) {
        if (config.staleWhileRevalidate) {
          this.backgroundRefresh(cacheKey, computeFn, config.ttl);
        }
      }

      return envelope.data;
    }

    // Cache miss — compute fresh
    const result = await computeFn();
    await this.setEnvelope(cacheKey, result, config.ttl);
    return result;
  }

  // -------------------------------------------------------------------
  // PUBLIC: emit invalidation events from application services
  // -------------------------------------------------------------------

  emit(event: AnalyticsEventType, payload: InvalidationPayload): void {
    this.events.emit(event, payload);
  }

  // -------------------------------------------------------------------
  // PUBLIC: force refresh for a specific tenant + report
  // -------------------------------------------------------------------

  async invalidateTenantReport(
    tenantId: string,
    reportTypes: ReportType[]
  ): Promise<void> {
    for (const reportType of reportTypes) {
      const pattern = `analytics:${tenantId}:${reportType}:*`;
      await this.deleteByPattern(pattern);
    }
  }

  async invalidateAllTenant(tenantId: string): Promise<void> {
    const pattern = `analytics:${tenantId}:*`;
    await this.deleteByPattern(pattern);
  }

  // -------------------------------------------------------------------
  // PRIVATE: Invalidation handlers
  // -------------------------------------------------------------------

  private registerInvalidationHandlers(): void {
    for (const eventType of Object.values(AnalyticsEventType)) {
      const reportTypes = INVALIDATION_MAP[eventType];
      this.events.on(eventType, async (payload: InvalidationPayload) => {
        await this.invalidateTenantReport(payload.tenant_id, reportTypes);
      });
    }
  }

  // -------------------------------------------------------------------
  // PRIVATE: Cache helpers
  // -------------------------------------------------------------------

  private async setEnvelope<T>(
    key: string,
    data: T,
    ttl: number
  ): Promise<void> {
    const envelope: CacheEnvelope<T> = {
      data,
      expiresAt: Date.now() + ttl * 1000,
      computedAt: Date.now(),
    };
    await this.redis.setex(key, ttl, JSON.stringify(envelope));
  }

  private async deleteByPattern(pattern: string): Promise<void> {
    const keys = await this.scanKeys(pattern);
    if (keys.length > 0) {
      const pipeline = this.redis.pipeline();
      pipeline.del(...keys);
      await pipeline.exec();
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, found] = await this.redis.scan(cursor, pattern, 100);
      cursor = nextCursor;
      keys.push(...found);
    } while (cursor !== "0");
    return keys;
  }

  private backgroundRefresh<T>(
    cacheKey: string,
    computeFn: () => Promise<T>,
    ttl: number
  ): void {
    setImmediate(async () => {
      try {
        const fresh = await computeFn();
        await this.setEnvelope(cacheKey, fresh, ttl);
      } catch {
        // Silently ignore — user still has stale data
      }
    });
  }
}

// ---------------------------------------------------------------------------
// SMART INVALIDATION HELPER
// ---------------------------------------------------------------------------
// Instead of blanket invalidation, checks if the posted journal entry
// touches accounts relevant to specific cache types. Call this from your
// journal posting service after a successful commit.

export interface AccountClassification {
  account_id: number;
  cash_flow_section: "OPERATING" | "INVESTING" | "FINANCING" | null;
  account_type: "Asset" | "Liability" | "Equity" | "Income" | "Expense";
  account_sub_type: string | null;
  is_cash_account: boolean;
}

export function determineAffectedReports(
  accountIds: number[],
  classifications: AccountClassification[]
): ReportType[] {
  const reports = new Set<ReportType>();

  for (const acct of classifications) {
    reports.add("executive_dashboard"); // always invalidate summary on any change

    if (
      acct.account_type === "Income" ||
      acct.account_type === "Expense" ||
      acct.cash_flow_section !== null
    ) {
      reports.add("ratios");
    }

    if (
      acct.is_cash_account ||
      acct.cash_flow_section !== null
    ) {
      reports.add("cash_flow");
    }

    if (acct.account_sub_type === "CURRENT" || acct.account_sub_type === "NON_CURRENT") {
      reports.add("ratios");
      reports.add("cash_flow");
    }
  }

  return Array.from(reports);
}

// ---------------------------------------------------------------------------
// SINGLETON — export a default instance for the application
// ---------------------------------------------------------------------------

export const analyticsCache = new AnalyticsCache();

// ---------------------------------------------------------------------------
// INTEGRATION EXAMPLE — wire into your journal posting service:
// ---------------------------------------------------------------------------
//
// import { analyticsCache, determineAffectedReports } from "./analytics-cache";
// import { AnalyticsEventType } from "./analytics-types";
//
// async function postJournalEntry(txn: CreateTransaction): Promise<number> {
//   const txnId = await db.insertTransaction(txn);
//
//   // After commit, invalidate affected caches
//   const classifications = await analyticsSvc.getAccountClassifications(
//     txn.entries.map(e => e.accountId)
//   );
//   const affected = determineAffectedReports(
//     txn.entries.map(e => e.accountId),
//     classifications
//   );
//
//   analyticsCache.emit(AnalyticsEventType.JOURNAL_POSTED, {
//     tenant_id: txn.tenantId,
//     journal_entry: {
//       account_ids: txn.entries.map(e => e.accountId),
//       transaction_date: txn.txnDate,
//     },
//   });
//
//   return txnId;
// }
// ---------------------------------------------------------------------------
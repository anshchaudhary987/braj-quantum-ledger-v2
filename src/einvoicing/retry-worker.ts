// ============================================================================
// RETRY WORKER — Background Queue Sweeper
//
// Design:
//   - Runs on a configurable interval (default 30 seconds)
//   - Sweeps api_retry_queue for items where status='QUEUED' AND next_retry_at <= NOW()
//   - Processes up to BATCH_SIZE items per tick
//   - Each item is processed via EinvoiceService.processRetryItem() inside its
//     own DB transaction
//
// Exponential Backoff Formula:
//   next_retry_at = last_attempted_at + 2^attempt_count seconds
//
// Graceful shutdown: stops processing on SIGTERM/SIGINT; completes in-flight
// items before exiting.
//
// Concurrency-safe: uses FOR UPDATE SKIP LOCKED to prevent duplicate processing
// across multiple worker instances (horizontal scaling).
// ============================================================================

import { PoolClient } from "pg";
import { getPool, withClient, withTransaction } from "../db/pool";
import { EinvoiceService } from "./einvoice-service";
import { RetryQueueRow } from "./einvoice-types";

// ── Configuration ──────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Number(process.env.RETRY_WORKER_INTERVAL_MS) || 30_000;
const BATCH_SIZE = Number(process.env.RETRY_WORKER_BATCH_SIZE) || 10;
const MAX_CONCURRENCY = Number(process.env.RETRY_WORKER_MAX_CONCURRENCY) || 5;

// ── State ──────────────────────────────────────────────────────────────────

let running = false;
let shutdownRequested = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ── PUBLIC API ─────────────────────────────────────────────────────────────

export class RetryWorker {
  /**
   * Start the background sweep loop. Safe to call multiple times.
   */
  static start(): void {
    if (running) {
      console.log("[RetryWorker] Already running — skipped start");
      return;
    }
    running = true;
    shutdownRequested = false;
    console.log(`[RetryWorker] Started — sweep every ${SWEEP_INTERVAL_MS}ms, batch ${BATCH_SIZE}, concurrency ${MAX_CONCURRENCY}`);

    // Register graceful shutdown handlers
    process.on("SIGTERM", RetryWorker.shutdown);
    process.on("SIGINT", RetryWorker.shutdown);

    // Initial sweep immediately, then on interval
    RetryWorker.sweep();
    intervalHandle = setInterval(() => RetryWorker.sweep(), SWEEP_INTERVAL_MS);
  }

  /**
   * Gracefully stop the sweep loop. Completes in-flight items.
   */
  static shutdown(): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log("[RetryWorker] Shutdown requested — draining in-flight items...");
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    running = false;
  }

  /**
   * Force a single manual sweep (useful for testing / admin API).
   * Returns the count of items processed.
   */
  static async sweepOnce(): Promise<number> {
    return RetryWorker.sweep();
  }

  /**
   * Get current worker status for health checks.
   */
  static getStatus(): { running: boolean; shutdownRequested: boolean } {
    return { running, shutdownRequested };
  }

  // ── PRIVATE — Sweep Logic ────────────────────────────────────────────────

  private static async sweep(): Promise<number> {
    if (shutdownRequested) return 0;

    const pool = getPool();
    const client = await pool.connect();

    try {
      // SELECT + LOCK pending items with SKIP LOCKED for concurrency safety
      const { rows } = await client.query<RetryQueueRow>(
        `SELECT * FROM api_retry_queue
         WHERE status = 'QUEUED'
           AND next_retry_at <= now()
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );

      if (rows.length === 0) return 0;

      console.log(`[RetryWorker] Sweep found ${rows.length} items due for retry`);

      // Process with bounded concurrency
      let processed = 0;
      const chunks = RetryWorker.chunkArray(rows, MAX_CONCURRENCY);

      for (const chunk of chunks) {
        if (shutdownRequested) break;

        await Promise.allSettled(
          chunk.map((item) =>
            withClient(async (procClient) => {
              return withTransaction(procClient, async (txClient: PoolClient) => {
                const service = new EinvoiceService(txClient);
                await service.processRetryItem(item);
              });
            }).catch((err) => {
              console.error(`[RetryWorker] Failed to process retry #${item.retry_id}: ${err instanceof Error ? err.message : String(err)}`);
            })
          )
        );

        processed += chunk.length;
      }

      if (processed > 0) {
        console.log(`[RetryWorker] Completed ${processed} items`);
      }

      return processed;
    } catch (err) {
      console.error(`[RetryWorker] Sweep error: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      client.release();
    }
  }

  private static chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
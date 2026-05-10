import { Router } from "express";
import { getPool } from "../../db/pool";
import { logger } from "../../config/logger";

const router = Router();

// ---------------------------------------------------------------------------
// HEALTH CHECK ENDPOINT
// ---------------------------------------------------------------------------
// Returns:
//   200 OK — All services healthy
//   503 Service Unavailable — One or more services down
// ---------------------------------------------------------------------------

interface HealthStatus {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    database: { status: "ok" | "error"; latency_ms: number; message?: string };
    memory: { status: "ok" | "warning" | "error"; used_mb: number; total_mb: number };
  };
}

router.get("/health", async (_req, res) => {
  const startTime = Date.now();
  const pool = getPool();
  const health: HealthStatus = {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION ?? "1.0.0",
    uptime: process.uptime(),
    checks: {
      database: { status: "error", latency_ms: 0, message: "Not checked" },
      memory: { status: "ok", used_mb: 0, total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) },
    },
  };

  let dbHealthy = false;

  // ---- Check 1: Database connectivity ----
  let client;
  try {
    client = await pool.connect();
    const dbStart = Date.now();
    await client.query("SELECT 1");
    const dbLatency = Date.now() - dbStart;

    health.checks.database = {
      status: "ok",
      latency_ms: dbLatency,
    };
    dbHealthy = true;
  } catch (err) {
    health.checks.database = {
      status: "error",
      latency_ms: Date.now() - startTime,
      message: err instanceof Error ? err.message : "Unknown DB error",
    };
    logger.error({ err, source: "health-check" }, "Database health check failed");
  } finally {
    if (client) client.release();
  }

  // ---- Check 2: Memory usage ----
  const memUsage = process.memoryUsage();
  const usedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  health.checks.memory.used_mb = usedMB;

  // Warn if > 512MB (tune as needed)
  if (usedMB > 512) {
    health.checks.memory.status = "warning";
    logger.warn({ usedMB, source: "health-check" }, "High memory usage detected");
  }

  // ---- Determine overall status ----
  if (!dbHealthy) {
    health.status = "error";
    res.status(503);
  } else if (health.checks.memory.status === "warning") {
    health.status = "degraded";
    res.status(200);
  } else {
    health.status = "ok";
    res.status(200);
  }

  res.json(health);
});

export default router;

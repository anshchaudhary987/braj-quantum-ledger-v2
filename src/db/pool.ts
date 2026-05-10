import { Pool, PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// DATABASE CONNECTION POOL
// ---------------------------------------------------------------------------

export interface DbSecurityContext {
  companyId: number;
  userId: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const securityContextStore = new AsyncLocalStorage<DbSecurityContext>();

const connectionString =
  process.env.DATABASE_URL ??
  process.env.NEON_DATABASE_URL ??
  process.env.DB_URL;

const sslEnabled =
  process.env.DB_SSL === "true" ||
  Boolean(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);

const pool = new Pool({
  ...(connectionString
    ? { connectionString }
    : {
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME ?? "glm_ledger",
        user: process.env.DB_USER ?? "glm_app",
        password: process.env.DB_PASSWORD ?? "",
      }),
  ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS) || 30_000,
  connectionTimeoutMillis: 5000,
});

// ---------------------------------------------------------------------------
// POOL EVENT MONITORING — critical for production observability
// ---------------------------------------------------------------------------

pool.on("error", (err: Error, _client: PoolClient) => {
  console.error(JSON.stringify({
    level: "error",
    source: "db_pool",
    message: "Unexpected PostgreSQL pool error",
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  }));
  // Do not exit here — let the process manager handle restarts
  // The pool will attempt to reconnect automatically
});

pool.on("connect", () => {
  // Optional: track connection count for metrics
});

pool.on("remove", () => {
  // Optional: track connection removals for metrics
});

// Graceful shutdown: drain pool on SIGTERM/SIGINT
function gracefulShutdown(): void {
  console.log("Draining database pool...");
  pool.end().then(() => {
    console.log("Database pool drained successfully.");
    process.exit(0);
  }).catch((err) => {
    console.error("Error draining database pool:", err);
    process.exit(1);
  });
}

if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);
}

export function getPool(): Pool {
  return pool;
}

export function runWithDbSecurityContext<T>(
  context: DbSecurityContext,
  fn: () => T
): T {
  return securityContextStore.run(context, fn);
}

export function getDbSecurityContext(): DbSecurityContext | undefined {
  return securityContextStore.getStore();
}

async function applySecurityContext(
  client: PoolClient,
  context: DbSecurityContext
): Promise<void> {
  await client.query(
    `SELECT init_security_context($1, $2, $3, $4)`,
    [
      context.companyId,
      context.userId,
      context.ipAddress ?? null,
      context.userAgent ?? null,
    ]
  );
}

async function clearSecurityContext(client: PoolClient): Promise<void> {
  await client.query(`
    RESET app.current_company_id;
    RESET app.current_user_id;
    RESET app.current_ip_address;
    RESET app.current_user_agent;
    RESET app.current_session_id
  `);
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const context = getDbSecurityContext();

  try {
    if (context) {
      await applySecurityContext(client, context);
    }

    return await fn(client);
  } finally {
    try {
      if (context) {
        await clearSecurityContext(client);
      }
    } finally {
      client.release();
    }
  }
}

export async function withTransaction<T>(
  client: PoolClient,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

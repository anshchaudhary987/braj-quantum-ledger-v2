import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getPool } from "../src/db/pool";
import { logger } from "../src/config/logger";

// ---------------------------------------------------------------------------
// MIGRATION RUNNER
// ---------------------------------------------------------------------------
// Usage: tsx scripts/run-migrations.ts [up|down|create <name>]
// ---------------------------------------------------------------------------

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

interface Migration {
  name: string;
  path: string;
}

function getMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => ({
    name: f,
    path: join(MIGRATIONS_DIR, f),
  }));
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ migration_name: string }>(
      "SELECT migration_name FROM schema_migrations"
    );
    return new Set(rows.map((r) => r.migration_name));
  } catch (err) {
    logger.error({ err }, "Failed to read applied migrations");
    throw err;
  } finally {
    client.release();
  }
}

async function applyMigration(name: string, sql: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
      [name]
    );
    await client.query("COMMIT");
    logger.info({ migration: name }, "Migration applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ err, migration: name }, "Migration failed");
    throw err;
  } finally {
    client.release();
  }
}

async function rollbackMigration(name: string, sql: string): Promise<void> {
  const downIndex = sql.indexOf("-- DOWN");
  const downSql = downIndex > 0 ? sql.slice(downIndex + 7) : "";
  if (!downSql.trim()) {
    logger.warn({ migration: name }, "No DOWN script found; skipping rollback");
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(downSql);
    await client.query(
      "DELETE FROM schema_migrations WHERE migration_name = $1",
      [name]
    );
    await client.query("COMMIT");
    logger.info({ migration: name }, "Migration rolled back successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ err, migration: name }, "Rollback failed");
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations(): Promise<void> {
  const command = process.argv[2] ?? "up";
  const migrations = getMigrations();
  const applied = await getAppliedMigrations();

  logger.info({
    total: migrations.length,
    applied: applied.size,
    pending: migrations.length - applied.size,
  }, "Found migrations");

  if (command === "up") {
    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        logger.debug({ migration: migration.name }, "Already applied, skipping");
        continue;
      }
      const sql = readFileSync(migration.path, "utf-8");
      await applyMigration(migration.name, sql);
    }
  } else if (command === "down") {
    // Rollback last applied migration
    const lastApplied = [...applied].pop();
    if (lastApplied) {
      const migration = migrations.find((m) => m.name === lastApplied)!;
      const sql = readFileSync(migration.path, "utf-8");
      await rollbackMigration(migration.name, sql);
    }
  } else if (command === "create" && process.argv[3]) {
    const timestamp = new Date().toISOString().replace(/[-T:.]/g, "").slice(0, 14);
    const name = `${timestamp}_${process.argv[3]}.sql`;
    const path = join(MIGRATIONS_DIR, name);
    logger.info({ path }, "Create migration stub");
    // User creates migration manually; this just logs the path
  }
}

runMigrations().catch((err) => {
  logger.error({ err }, "Migration runner failed");
  process.exit(1);
});

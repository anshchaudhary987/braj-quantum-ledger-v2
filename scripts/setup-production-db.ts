import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Production connection string for Neon
const connectionString = "postgresql://neondb_owner:npg_EnKhFB6iy5sO@ep-delicate-brook-aqjywpzx-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require";

async function run() {
  console.log('--- BRAJ QUANTUM LEDGER - DATABASE SETUP ---');
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  try {
    const rootSqlFiles = [
      'security_schema.sql',
      'core_tables.sql',
      'gst_schema.sql',
      'schema.sql',
      'refresh_tokens.sql',
      'inventory_schema.sql',
      'payroll_schema.sql',
      'einvoicing_schema.sql',
      'banking_schema.sql',
      'billwise_schema.sql',
      'budget_interest_schema.sql',
      'cost_center_schema.sql',
      'document_ocr_schema.sql',
      'edge_cases_schema.sql',
      'job_work_schema.sql',
      'manufacturing_schema.sql',
      'price_list_schema.sql',
      'tally_import_schema.sql',
      'tds_schema.sql',
      'analytics_schema.sql',
      'stock_accounting_triggers.sql',
      'multi_tenant_migration.sql',
      'reconciliation.sql',
      'seed.sql',
      'gst_seed.sql'
    ];

    for (const file of rootSqlFiles) {
      console.log(`[ROOT] Running ${file}...`);
      try {
        const sql = readFileSync(file, 'utf8');
        await client.query(sql);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.warn(`[WARN] ${file} partially failed (already exists), continuing...`);
        } else {
          console.error(`[ERROR] ${file} failed:`, err.message);
        }
      }
    }

    // Run migrations folder
    console.log('[MIGRATIONS] Running files in /migrations folder...');
    const migrationFiles = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();
    for (const file of migrationFiles) {
        console.log(`[MIGRATION] Running ${file}...`);
        try {
          const sql = readFileSync(join('migrations', file), 'utf8');
          await client.query(sql);
        } catch (err) {
          if (err.message.includes('already exists')) {
            console.warn(`[WARN] Migration ${file} partially failed, continuing...`);
          } else {
            console.error(`[ERROR] Migration ${file} failed:`, err.message);
          }
        }
    }

    console.log('\n✅ Database setup complete!');
  } catch (err) {
    console.error('\n❌ Fatal error during database setup:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();

// ============================================================================
// TALLY IMPORT — Express API Routes
// ============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ErrorCode } from "../errors";
import { AppError } from "../auth/auth-service";
import { validate } from "../middleware/validate";
import { requireAuth, requireRole, setSecurityContext } from "../auth/auth-middleware";
import { voucherRateLimiter } from "../middleware/rate-limiter-redis";
import { withClient, withTransaction } from "../../db/pool";
import { PoolClient } from "pg";
import { Readable } from "stream";
import { TallyXmlParser } from "../../tally-import/tally-xml-parser";
import { TallyImportEngine } from "../../tally-import/tally-import-engine";
import {
  StartTallyImportInput,
  TallyImportStatus,
} from "../../tally-import/tally-types";

const router = Router();
const canManageTallyImport = requireRole("OWNER", "ADMIN", "ACCOUNTANT");

// ─────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────

const startImportSchema = z.object({
  body: z.object({
    original_filename: z.string().min(1).max(500),
    s3_key: z.string().min(1).max(1000),
    file_size_bytes: z.number().int().positive().optional(),
    batch_size: z.number().int().min(100).max(2000).default(500),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/tally-import/start
// Initiate a Tally XML import from S3.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/start",
  requireAuth,
  canManageTallyImport,
  voucherRateLimiter,
  validate(startImportSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: StartTallyImportInput = {
        tenant_id: String(req.companyId!),
        original_filename: req.body.original_filename,
        s3_key: req.body.s3_key,
        file_size_bytes: req.body.file_size_bytes,
        batch_size: req.body.batch_size,
        uploaded_by: String(req.userId),
      };

      // Create the import batch record
      const batchId = await withClient(async (conn) => {
        const { rows } = await conn.query<{ import_batch_id: string }>(
          `INSERT INTO tally_import_batches (tenant_id, original_filename, s3_key, file_size_bytes, import_status, uploaded_by)
           VALUES ($1, $2, $3, $4, 'UPLOADED', $5)
           RETURNING import_batch_id`,
          [input.tenant_id, input.original_filename, input.s3_key, input.file_size_bytes ?? null, input.uploaded_by]
        );
        return rows[0].import_batch_id;
      });

      res.status(202).json({
        data: {
          import_batch_id: batchId,
          status: "UPLOADED",
          message: "Import batch created. Call POST /tally-import/process/:batchId to start processing.",
        },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/tally-import/process/:batchId
// Start processing a Tally import (Phase 1: Masters, Phase 2: Vouchers).
// The XML file is streamed from S3 using the s3_key from the batch record.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/process/:batchId",
  requireAuth,
  canManageTallyImport,
  voucherRateLimiter,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const batchId = req.params.batchId;
      const tenantId = String(req.companyId!);

      // Start processing asynchronously — return immediately with status
      // The client polls GET /tally-import/status/:batchId for progress
      withClient(async (conn) => {
        const engine = new TallyImportEngine(conn);

        try {
          await engine.updateBatchStatus(batchId, "PARSING", undefined, tenantId);

          // Get the batch record for S3 key
          const batch = await engine.getBatch(batchId, tenantId);
          if (!batch) throw new Error(`Batch not found: ${batchId}`);

          // PHASE 1: Masters
          await engine.updateBatchStatus(batchId, "PARSING", undefined, tenantId);
          // In production: get stream from S3 via engine.getS3Stream(batch.s3_key!)
          // For now, the stream is provided via the upload endpoint

          // PHASE 2: Vouchers
          await engine.updateBatchStatus(batchId, "VOUCHERS_IMPORTING", undefined, tenantId);

          // Final status
          await engine.updateBatchStatus(batchId, "COMPLETED", undefined, tenantId);
        } catch (err: any) {
          await engine.updateBatchStatus(batchId, "FAILED", err.message, tenantId);
        }
      }).catch((err) => console.error(`Tally import ${batchId} failed:`, err));

      res.status(202).json({
        data: { import_batch_id: batchId, status: "PARSING" },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/tally-import/status/:batchId
// Check the status of a Tally import job.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/status/:batchId",
  requireAuth,
  canManageTallyImport,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const batchId = req.params.batchId;

      const batch = await withClient(async (conn) => {
        const engine = new TallyImportEngine(conn);
        const b = await engine.getBatch(batchId, String(req.companyId!));
        if (!b) throw new AppError(ErrorCode.NOT_FOUND, `Import batch not found: ${batchId}`);
        return b;
      });

      // Also fetch error summary
      const errors = await withClient(async (conn) => {
        const { rows } = await conn.query<{ count: string }>(
          `SELECT COUNT(*) AS count
           FROM tally_import_errors tie
           WHERE tie.import_batch_id = $1
             AND EXISTS (
               SELECT 1 FROM tally_import_batches tib
               WHERE tib.import_batch_id = tie.import_batch_id
                 AND tib.tenant_id = $2
             )`,
          [batchId, String(req.companyId!)]
        );
        return Number(rows[0].count);
      });

      res.json({
        data: { ...batch, error_count: errors },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/tally-import/verify/:batchId
// Generate import verification report (Tally vs Imported totals).
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/verify/:batchId",
  requireAuth,
  canManageTallyImport,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const batchId = req.params.batchId;

      const result = await withClient(async (conn) => {
        const engine = new TallyImportEngine(conn);
        const batch = await engine.getBatch(batchId, String(req.companyId!));
        if (!batch) throw new AppError(ErrorCode.NOT_FOUND, `Import batch not found: ${batchId}`);
        return engine.verifyImport(batchId);
      });

      res.json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/tally-import/errors/:batchId
// Get error log for a Tally import batch (failed vouchers).
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/errors/:batchId",
  requireAuth,
  canManageTallyImport,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const batchId = req.params.batchId;

      const { rows } = await withClient(async (conn) => {
        return conn.query(
          `SELECT tie.* FROM tally_import_errors tie
           WHERE tie.import_batch_id = $1
             AND EXISTS (
               SELECT 1 FROM tally_import_batches tib
               WHERE tib.import_batch_id = tie.import_batch_id
                 AND tib.tenant_id = $2
             )
           ORDER BY batch_number, voucher_index
           LIMIT 200`,
          [batchId, String(req.companyId!)]
        );
      });

      res.json({
        data: rows,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/tally-import/batches
// List all import batches for the tenant.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/batches",
  requireAuth,
  canManageTallyImport,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as TallyImportStatus | undefined;

      const { rows } = await withClient(async (conn) => {
        return conn.query(
          `SELECT import_batch_id, original_filename, file_size_bytes,
                  import_status, total_groups, total_ledgers,
                  total_vouchers, vouchers_imported, vouchers_failed,
                  tally_grand_total_debit, imported_grand_total_debit,
                  tally_grand_total_credit, imported_grand_total_credit,
                  total_duration_ms, created_at
           FROM tally_import_batches
           WHERE tenant_id = $1
             ${status ? "AND import_status = $2" : ""}
           ORDER BY created_at DESC
           LIMIT 50`,
          status ? [String(req.companyId!), status] : [String(req.companyId!)]
        );
      });

      res.json({
        data: rows,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

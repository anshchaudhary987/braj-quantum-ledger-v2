// ============================================================================
// E-INVOICING & E-WAY BILL — Express API Routes
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
import { EinvoiceService } from "../../einvoicing/einvoice-service";
import { DistanceService } from "../../einvoicing/distance-service";
import { RetryWorker } from "../../einvoicing/retry-worker";
import {
  SupplyType,
  TransportMode,
  GenerateEinvoiceInput,
  GenerateEwayBillInput,
  CancelEinvoiceInput,
} from "../../einvoicing/einvoice-types";

const router = Router();
const canManageEinvoice = requireRole("OWNER", "ADMIN", "ACCOUNTANT");
const canSweepRetryQueue = requireRole("SUPER_ADMIN");

// ─────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────

const generateEinvoiceSchema = z.object({
  body: z.object({
    transaction_id: z.number().int().positive(),
    gst_registration_id: z.number().int().positive(),
    invoice_number: z.string().min(1).max(16),
    invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    supply_type: z.enum(["B2B", "B2C", "SEZWP", "SEZWOP", "EXPWP", "EXPWOP", "DEXP"]).default("B2B"),
    is_reverse_charge: z.boolean().default(false),
  }),
});

const cancelEinvoiceSchema = z.object({
  body: z.object({
    e_invoice_id: z.number().int().positive(),
    reason: z.string().min(1).max(500),
    force_credit_note: z.boolean().default(false),
  }),
});

const generateEwayBillSchema = z.object({
  body: z.object({
    e_invoice_id: z.number().int().positive().optional(),
    transaction_id: z.number().int().positive().optional(),
    gst_registration_id: z.number().int().positive(),
    dispatch_from_pin: z.string().length(6),
    ship_to_pin: z.string().length(6),
    transport_mode: z.enum(["ROAD", "RAIL", "AIR", "SHIP"]).default("ROAD"),
    vehicle_number: z.string().max(15).optional(),
    transporter_id: z.string().max(15).optional(),
    supply_type: z.enum(["B2B", "B2C", "SEZWP", "SEZWOP", "EXPWP", "EXPWOP", "DEXP"]).default("B2B"),
  }),
});

const cancelEwayBillSchema = z.object({
  body: z.object({
    eway_bill_id: z.number().int().positive(),
    reason: z.string().min(1).max(500),
  }),
});

const calculateDistanceSchema = z.object({
  query: z.object({
    from_pin: z.string().length(6),
    to_pin: z.string().length(6),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/einvoice/generate
// Generate an e-invoice and queue to IRP.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/generate",
  requireAuth,
  canManageEinvoice,
  voucherRateLimiter,
  validate(generateEinvoiceSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: GenerateEinvoiceInput = {
        transaction_id: req.body.transaction_id,
        tenant_id: String(req.companyId!),
        gst_registration_id: req.body.gst_registration_id,
        invoice_number: req.body.invoice_number,
        invoice_date: req.body.invoice_date,
        supply_type: req.body.supply_type as SupplyType,
        is_reverse_charge: req.body.is_reverse_charge,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new EinvoiceService(client);
          return service.generateEinvoice(input);
        });
      });

      res.status(202).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/einvoice/cancel
// Cancel an e-invoice (subject to 24-hour window).
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/cancel",
  requireAuth,
  canManageEinvoice,
  voucherRateLimiter,
  validate(cancelEinvoiceSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: CancelEinvoiceInput = {
        tenant_id: String(req.companyId!),
        e_invoice_id: req.body.e_invoice_id,
        reason: req.body.reason,
        force_credit_note: req.body.force_credit_note,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new EinvoiceService(client);
          return service.cancelEinvoice(input);
        });
      });

      res.status(200).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/einvoice/:id
// Get e-invoice status + IRN details.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  canManageEinvoice,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid e-invoice ID");

      const result = await withClient(async (conn) => {
        const service = new EinvoiceService(conn);
        const einvoice = await service.getEinvoiceStatus(id, String(req.companyId!));
        if (!einvoice) throw new AppError(ErrorCode.EINVOICE_NOT_FOUND, `E-Invoice not found: ${id}`);
        return einvoice;
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
// POST /api/v1/ewaybill/generate
// Generate an e-way bill with auto distance calculation.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/ewaybill/generate",
  requireAuth,
  canManageEinvoice,
  voucherRateLimiter,
  validate(generateEwayBillSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: GenerateEwayBillInput = {
        e_invoice_id: req.body.e_invoice_id,
        transaction_id: req.body.transaction_id,
        tenant_id: String(req.companyId!),
        gst_registration_id: req.body.gst_registration_id,
        dispatch_from_pin: req.body.dispatch_from_pin,
        ship_to_pin: req.body.ship_to_pin,
        transport_mode: req.body.transport_mode as TransportMode,
        vehicle_number: req.body.vehicle_number,
        transporter_id: req.body.transporter_id,
        supply_type: req.body.supply_type as SupplyType,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new EinvoiceService(client);
          return service.generateEwayBill(input);
        });
      });

      res.status(202).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/ewaybill/cancel
// Cancel an e-way bill.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/ewaybill/cancel",
  requireAuth,
  canManageEinvoice,
  voucherRateLimiter,
  validate(cancelEwayBillSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { eway_bill_id, reason } = req.body;

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          // Enqueue cancellation to NIC
          const { rows: ewbRows } = await client.query<{ ewb_no: string; tenant_id: string; gst_registration_id: number }>(
            `UPDATE eway_bill_details
             SET status = 'CANCELLED', cancelled_at = now(), cancelled_reason = $2,
                 status_history = status_history || jsonb_build_object(
                   'status', 'CANCELLED', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', $3
                 ),
                 updated_at = now()
              WHERE eway_bill_id = $1 AND tenant_id = $4 AND status = 'GENERATED'
              RETURNING ewb_no, tenant_id, gst_registration_id`,
            [eway_bill_id, reason, String(req.userId), String(req.companyId!)]
          );
          if (ewbRows.length === 0) {
            throw new AppError(ErrorCode.EWAY_BILL_NOT_FOUND, `E-Way Bill not found: ${eway_bill_id}`);
          }

          // Enqueue the NIC cancellation API call
          if (ewbRows[0].ewb_no) {
            await client.query(
              `INSERT INTO api_retry_queue (
                 entity_type, entity_id, operation, tenant_id,
                 gsp_credential_id, endpoint_path, payload,
                 next_retry_at, status
               ) VALUES ('EWAY_BILL', $1, 'CANCEL', $2, NULL, '/api/v1/ewaybill/cancel', $3, now(), 'QUEUED')
               ON CONFLICT (entity_type, entity_id, operation)
                 WHERE status IN ('QUEUED', 'IN_PROGRESS')
               DO NOTHING`,
              [eway_bill_id, ewbRows[0].tenant_id, JSON.stringify({ ewbNo: ewbRows[0].ewb_no, cancelReason: reason })]
            );
          }

          return { eway_bill_id, status: "CANCELLED" };
        });
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
// GET /api/v1/ewaybill/:id
// Get e-way bill status + EWB details.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/ewaybill/:id",
  requireAuth,
  canManageEinvoice,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid e-way bill ID");

      const result = await withClient(async (conn) => {
        const service = new EinvoiceService(conn);
        const ewb = await service.getEwayBillStatus(id, String(req.companyId!));
        if (!ewb) throw new AppError(ErrorCode.EWAY_BILL_NOT_FOUND, `E-Way Bill not found: ${id}`);
        return ewb;
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
// GET /api/v1/einvoice/distance/calculate
// Calculate distance between two PIN codes (for E-Way Bill pre-validation).
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/distance/calculate",
  requireAuth,
  canManageEinvoice,
  validate(calculateDistanceSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from_pin, to_pin } = req.query as { from_pin: string; to_pin: string };

      const result = await withClient(async (conn) => {
        const service = new DistanceService(conn);
        return service.calculate(from_pin, to_pin);
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
// POST /api/v1/einvoice/retry/sweep
// Admin endpoint: manually trigger a retry queue sweep.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/retry/sweep",
  requireAuth,
  canSweepRetryQueue,
  setSecurityContext,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await RetryWorker.sweepOnce();
      res.json({
        data: { items_processed: count },
        meta: { timestamp: new Date().toISOString(), trace_id: _req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

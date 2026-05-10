// ============================================================================
// AI DOCUMENT OCR — Express API Routes
// ============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ErrorCode } from "../errors.js";
import { AppError } from "../auth/auth-service.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireRole, setSecurityContext } from "../auth/auth-middleware.js";
import { voucherRateLimiter } from "../middleware/rate-limiter-redis.js";
import { withClient, withTransaction } from "../../db/pool.js";
import { PoolClient } from "pg";
import { DocumentService } from "../../ocr/document-service.js";
import { AiExtractionPipeline } from "../../ocr/ai-extraction.service.js";
import { PurchaseInvoiceVoucherStrategy } from "../../vouchers/purchase-voucher.js";
import { VoucherFactory } from "../../vouchers/voucher-factory.js";
import { TransactionManager } from "../../services/transaction-manager.js";
import {
  UploadDocumentInput,
  StartExtractionInput,
  ApproveDraftVoucherInput,
  RejectVoucherInput,
  AmendExtractionInput,
  CreateVendorFromExtractionInput,
  DocEntityType,
  OcrProvider,
  LlmModel,
  DocumentStatus,
} from "../../ocr/ocr-types.js";

const router = Router();
const canManageOcr = requireRole("OWNER", "ADMIN", "ACCOUNTANT");
const allowedAmendmentColumns = new Set([
  "invoice_number",
  "invoice_date",
  "due_date",
  "vendor_gstin",
  "vendor_name",
  "vendor_address",
  "vendor_phone",
  "vendor_email",
  "vendor_pan",
  "buyer_gstin",
  "buyer_name",
  "buyer_address",
  "place_of_supply",
  "sub_total",
  "total_tax",
  "gross_total",
  "round_off",
  "amount_in_words",
  "cgst_amount",
  "sgst_amount",
  "igst_amount",
  "cess_amount",
  "line_items",
  "overall_confidence",
  "critical_flags",
]);

VoucherFactory.register(new PurchaseInvoiceVoucherStrategy());

// ─────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────

const uploadDocumentSchema = z.object({
  body: z.object({
    original_filename: z.string().min(1).max(500),
    s3_bucket: z.string().min(1).max(200),
    s3_key: z.string().min(1).max(1000),
    file_size_bytes: z.number().int().positive().optional(),
    mime_type: z.string().max(100).optional(),
    page_count: z.number().int().min(1).default(1),
    file_hash_sha256: z.string().length(64).optional(),
    entity_type: z.enum(["PURCHASE_INVOICE", "EXPENSE_RECEIPT", "CREDIT_NOTE", "DEBIT_NOTE", "BANK_STATEMENT", "OTHER"]).default("PURCHASE_INVOICE"),
  }),
});

const startExtractionSchema = z.object({
  body: z.object({
    document_id: z.number().int().positive(),
    ocr_provider: z.enum(["AWS_TEXTRACT", "GOOGLE_DOC_AI", "TESSERACT"]).default("AWS_TEXTRACT"),
    llm_model: z.enum(["claude-3-opus", "claude-3-sonnet", "gpt-4o", "gpt-4-turbo", "llama-3-70b"]).default("claude-3-sonnet"),
  }),
});

const approveVoucherSchema = z.object({
  body: z.object({
    extraction_id: z.number().int().positive(),
    reviewed_by: z.string().min(1).max(100),
    reviewer_notes: z.string().max(500).optional(),
  }),
});

const rejectVoucherSchema = z.object({
  body: z.object({
    extraction_id: z.number().int().positive(),
    reviewed_by: z.string().min(1).max(100),
    reason: z.string().min(1).max(500),
  }),
});

const amendExtractionSchema = z.object({
  body: z.object({
    extraction_id: z.number().int().positive(),
    amended_by: z.string().min(1).max(100),
    amendments: z.record(z.unknown()),
  }),
});

const createVendorSchema = z.object({
  body: z.object({
    extraction_id: z.number().int().positive(),
    account_id: z.number().int().positive(),
    registration_type: z.enum(["REGULAR", "COMPOSITION", "URD", "SEZ", "SEZ_DEVELOPER"]).default("REGULAR"),
  }),
});

const listDocumentsSchema = z.object({
  query: z.object({
    status: z.string().optional(),
    entity_type: z.enum(["PURCHASE_INVOICE", "EXPENSE_RECEIPT", "CREDIT_NOTE", "DEBIT_NOTE", "BANK_STATEMENT", "OTHER"]).optional(),
    limit: z.string().transform(Number).pipe(z.number().int().min(1).max(200)).default("50"),
    offset: z.string().transform(Number).pipe(z.number().int().min(0)).default("0"),
  }),
});

const presignedUrlSchema = z.object({
  body: z.object({
    filename: z.string().min(1).max(500),
    content_type: z.string().min(1).max(100),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/ocr/upload
// Register an uploaded document (after S3 upload completes).
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/upload",
  requireAuth,
  canManageOcr,
  voucherRateLimiter,
  validate(uploadDocumentSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: UploadDocumentInput = {
        tenant_id: String(req.companyId!),
        original_filename: req.body.original_filename,
        s3_bucket: req.body.s3_bucket,
        s3_key: req.body.s3_key,
        file_size_bytes: req.body.file_size_bytes,
        mime_type: req.body.mime_type,
        page_count: req.body.page_count,
        file_hash_sha256: req.body.file_hash_sha256,
        entity_type: req.body.entity_type as DocEntityType,
        uploaded_by: String(req.userId),
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new DocumentService(client);
          return service.registerUpload(input);
        });
      });

      res.status(201).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/ocr/presigned-url
// Generate a presigned S3 upload URL for the client.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/presigned-url",
  requireAuth,
  canManageOcr,
  validate(presignedUrlSchema),
  setSecurityContext,
  (req: Request, res: Response) => {
    const service = new DocumentService(null as unknown as PoolClient);
    const result = service.generatePresignedUploadUrl(
      String(req.companyId!),
      req.body.filename,
      req.body.content_type
    );
    res.json({
      data: {
        url: result.url,
        fields: result.fields,
        key: result.key,
      },
      meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/ocr/documents
// List documents with optional status/type filters.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/documents",
  requireAuth,
  canManageOcr,
  validate(listDocumentsSchema as any),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, entity_type, limit, offset } = req.query as Record<string, any>;

      const result = await withClient(async (conn) => {
        const service = new DocumentService(conn);
        return service.listDocuments(
          String(req.companyId!),
          status as DocumentStatus | undefined,
          entity_type as DocEntityType | undefined,
          Number(limit), Number(offset)
        );
      });

      res.json({
        data: result.documents,
        pagination: { total: result.total, limit: Number(limit), offset: Number(offset) },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/ocr/documents/:id
// Get a single document with its extraction results.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/documents/:id",
  requireAuth,
  canManageOcr,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = parseInt(req.params.id, 10);
      if (isNaN(docId)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid document ID");

      const result = await withClient(async (conn) => {
        const docService = new DocumentService(conn);
        const doc = await docService.getDocument(docId, String(req.companyId!));
        if (!doc) throw new AppError(ErrorCode.NOT_FOUND, `Document not found: ${docId}`);

        const { rows: extRows } = await conn.query(
          `SELECT * FROM ocr_extraction_results WHERE document_id = $1 AND tenant_id = $2`,
          [docId, String(req.companyId!)]
        );

        return { document: doc, extraction: extRows[0] ?? null };
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
// POST /api/v1/ocr/extract
// Start the AI extraction pipeline on an uploaded document.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/extract",
  requireAuth,
  canManageOcr,
  voucherRateLimiter,
  validate(startExtractionSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: StartExtractionInput = {
        tenant_id: String(req.companyId!),
        document_id: req.body.document_id,
        ocr_provider: req.body.ocr_provider as OcrProvider,
        llm_model: req.body.llm_model as LlmModel,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const pipeline = new AiExtractionPipeline(client);
          return pipeline.runFullPipeline(input);
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
// POST /api/v1/ocr/approve
// Approve a draft voucher → creates journal entries via TransactionManager.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/approve",
  requireAuth,
  canManageOcr,
  voucherRateLimiter,
  validate(approveVoucherSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: ApproveDraftVoucherInput = {
        extraction_id: req.body.extraction_id,
        reviewed_by: req.body.reviewed_by,
        reviewer_notes: req.body.reviewer_notes,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          // Load extraction data
          const { rows: extRows } = await client.query(
            `SELECT * FROM ocr_extraction_results WHERE extraction_id = $1 AND tenant_id = $2`,
            [input.extraction_id, String(req.companyId!)]
          );
          const ext = extRows[0];
          if (!ext) throw new AppError(ErrorCode.NOT_FOUND, "Extraction result not found");
          if (ext.review_status === "APPROVED") throw new AppError(ErrorCode.CONFLICT, "Already approved");

          // Load vendor account
          let vendorAccountId: number;
          if (ext.matched_vendor_id) {
            const { rows: grRows } = await client.query<{ account_id: number }>(
              `SELECT account_id FROM gst_registrations
               WHERE gst_registration_id = $1 AND company_id = $2`,
              [ext.matched_vendor_id, req.companyId!]
            );
            if (grRows.length === 0) throw new AppError(ErrorCode.NOT_FOUND, "Vendor not found");
            vendorAccountId = grRows[0].account_id;
          } else {
            throw new AppError(ErrorCode.NOT_FOUND, "No vendor matched. Create a vendor first via /ocr/create-vendor.");
          }

          // Resolve expense ledger
          const expenseLedgerId = ext.suggested_ledger_id ?? (() => { throw new AppError(ErrorCode.NOT_FOUND, "No expense ledger suggested."); })();

          // Resolve tax input accounts (standard account codes)
          const { rows: cgstRows } = await client.query<{ account_id: number }>(
            `SELECT account_id FROM accounts WHERE account_code = '2115' AND is_active = TRUE LIMIT 1`
          );
          const { rows: sgstRows } = await client.query<{ account_id: number }>(
            `SELECT account_id FROM accounts WHERE account_code = '2116' AND is_active = TRUE LIMIT 1`
          );
          const { rows: igstRows } = await client.query<{ account_id: number }>(
            `SELECT account_id FROM accounts WHERE account_code = '2117' AND is_active = TRUE LIMIT 1`
          );

          // Create the accounting transaction via TransactionManager
          const txnMgr = new TransactionManager(client);
          const txnResult = await txnMgr.create({
            idempotency_key: `ocr-approve-${input.extraction_id}-${Date.now()}`,
            tenant_id: ext.tenant_id,
            txn_date: ext.invoice_date ?? new Date().toISOString().split("T")[0],
            description: `Purchase Invoice ${ext.invoice_number ?? "OCR"} — ${ext.vendor_name ?? "Unknown"} [AI Extracted]`,
            voucher_type: "PURCHASE_INVOICE_VOUCHER",
            voucher_payload: {
              expense_ledger_id: expenseLedgerId,
              vendor_account_id: vendorAccountId,
              cgst_input_account_id: cgstRows[0]?.account_id ?? 0,
              sgst_input_account_id: sgstRows[0]?.account_id ?? 0,
              igst_input_account_id: igstRows[0]?.account_id ?? 0,
              cess_input_account_id: 0,
              taxable_value: Number(ext.sub_total ?? 0),
              cgst_amount: Number(ext.cgst_amount ?? 0),
              sgst_amount: Number(ext.sgst_amount ?? 0),
              igst_amount: Number(ext.igst_amount ?? 0),
              cess_amount: Number(ext.cess_amount ?? 0),
              gross_total: Number(ext.gross_total ?? 0),
              invoice_number: ext.invoice_number,
              vendor_name: ext.vendor_name,
              extraction_id: input.extraction_id,
            },
          });

          // Link draft transaction to extraction
          await client.query(
            `UPDATE ocr_extraction_results
             SET draft_transaction_id = $2, review_status = 'APPROVED',
                 reviewed_by = $3, reviewer_notes = $4, reviewed_at = now(), updated_at = now()
             WHERE extraction_id = $1 AND tenant_id = $5`,
            [input.extraction_id, txnResult.transactionId, input.reviewed_by, input.reviewer_notes ?? null, String(req.companyId!)]
          );

          // Update document status
          await client.query(
            `UPDATE uploaded_documents
             SET upload_status = 'APPROVED', updated_at = now()
             WHERE document_id = $1 AND tenant_id = $2`,
            [ext.document_id, String(req.companyId!)]
          );

          return {
            extraction_id: input.extraction_id,
            transaction_id: txnResult.transactionId,
            status: "APPROVED",
          };
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
// POST /api/v1/ocr/reject
// Reject a draft voucher — document is flagged as bad quality.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/reject",
  requireAuth,
  canManageOcr,
  voucherRateLimiter,
  validate(rejectVoucherSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { extraction_id, reviewed_by, reason } = req.body;

      await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const { rows } = await client.query<{ document_id: number }>(
            `UPDATE ocr_extraction_results
             SET review_status = 'REJECTED', reviewed_by = $2,
                 reviewer_notes = $3, reviewed_at = now(), updated_at = now()
             WHERE extraction_id = $1 AND tenant_id = $4
               AND review_status NOT IN ('APPROVED', 'REJECTED')
             RETURNING document_id`,
            [extraction_id, reviewed_by, reason, String(req.companyId!)]
          );
          if (rows.length > 0) {
            await client.query(
              `UPDATE uploaded_documents SET upload_status = 'REJECTED', error_message = $2, updated_at = now()
               WHERE document_id = $1 AND tenant_id = $3`,
              [rows[0].document_id, reason, String(req.companyId!)]
            );
          }
          return rows;
        });
      });

      res.json({
        data: { extraction_id, status: "REJECTED" },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/ocr/amend
// Amend AI-extracted fields before approval (human correction).
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/amend",
  requireAuth,
  canManageOcr,
  voucherRateLimiter,
  validate(amendExtractionSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { extraction_id, amended_by, amendments } = req.body;

      await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          // Update only the amended fields in ocr_extraction_results
          const setClauses: string[] = [];
          const values: unknown[] = [extraction_id];
          let idx = 2;

          for (const [key, value] of Object.entries(amendments as Record<string, unknown>)) {
            if (!allowedAmendmentColumns.has(key)) {
              throw new AppError(ErrorCode.VALIDATION_ERROR, `Field cannot be amended: ${key}`);
            }

            setClauses.push(`${key} = $${idx++}`);
            values.push(value);
          }

          if (setClauses.length === 0) return null;

          setClauses.push(`review_status = 'AMENDED'`);
          setClauses.push(`reviewed_by = $${idx++}`);
          values.push(amended_by);
          setClauses.push(`reviewed_at = now()`);
          setClauses.push(`updated_at = now()`);

          await client.query(
            `UPDATE ocr_extraction_results
             SET ${setClauses.join(", ")}
             WHERE extraction_id = $1 AND tenant_id = $${idx}`,
            [...values, String(req.companyId!)]
          );

          // Update document status
          const { rows: docRows } = await client.query<{ document_id: number }>(
            `SELECT document_id FROM ocr_extraction_results
             WHERE extraction_id = $1 AND tenant_id = $2`,
            [extraction_id, String(req.companyId!)]
          );
          if (docRows.length > 0) {
            await client.query(
              `UPDATE uploaded_documents SET upload_status = 'DRAFT_READY', updated_at = now()
               WHERE document_id = $1 AND tenant_id = $2`,
              [docRows[0].document_id, String(req.companyId!)]
            );
          }

          return null;
        });
      });

      res.json({
        data: { extraction_id, status: "AMENDED" },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/ocr/create-vendor
// Create a new vendor from extraction data (when no GSTIN match found).
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/create-vendor",
  requireAuth,
  canManageOcr,
  voucherRateLimiter,
  validate(createVendorSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { extraction_id, account_id, registration_type } = req.body;

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const { rows: extRows } = await client.query<{
            vendor_gstin: string | null;
            vendor_name: string | null;
            tenant_id: string;
            place_of_supply: string | null;
            vendor_address: string | null;
          }>(
            `SELECT vendor_gstin, vendor_name, tenant_id, place_of_supply, vendor_address
             FROM ocr_extraction_results WHERE extraction_id = $1 AND tenant_id = $2`,
            [extraction_id, String(req.companyId!)]
          );
          const ext = extRows[0];
          if (!ext) throw new AppError(ErrorCode.NOT_FOUND, "Extraction result not found");

          const gstin = ext.vendor_gstin ?? `UNREG-${Date.now()}`;
          const stateCode = ext.place_of_supply ?? "00";

          const { rows: accountRows } = await client.query<{ account_id: number }>(
            `SELECT account_id FROM accounts
             WHERE account_id = $1 AND company_id = $2 AND is_active = TRUE`,
            [account_id, req.companyId!]
          );
          if (accountRows.length === 0) {
            throw new AppError(ErrorCode.NOT_FOUND, "Account not found for this company");
          }

          // Insert into gst_registrations
          const { rows: grRows } = await client.query<{ gst_registration_id: number }>(
            `INSERT INTO gst_registrations (company_id, account_id, gstin, legal_name, registration_type, state_code, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE)
             ON CONFLICT (gstin) DO UPDATE SET
               legal_name = EXCLUDED.legal_name, is_active = TRUE
               WHERE gst_registrations.company_id = EXCLUDED.company_id
             RETURNING gst_registration_id`,
            [req.companyId!, account_id, gstin, ext.vendor_name ?? "Unknown Vendor", registration_type, stateCode]
          );
          if (grRows.length === 0) {
            throw new AppError(ErrorCode.CONFLICT, "GSTIN already belongs to another company");
          }

          // Update extraction with new vendor
          await client.query(
            `UPDATE ocr_extraction_results
             SET matched_vendor_id = $2, matched_vendor_score = 100, is_new_vendor = FALSE, updated_at = now()
             WHERE extraction_id = $1 AND tenant_id = $3`,
            [extraction_id, grRows[0].gst_registration_id, String(req.companyId!)]
          );

          return { gst_registration_id: grRows[0].gst_registration_id, gstin };
        });
      });

      res.status(201).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/ocr/review/pending
// List all extractions pending human review, ordered by confidence (low first).
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/review/pending",
  requireAuth,
  canManageOcr,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await withClient(async (conn) => {
        return conn.query(
          `SELECT
             oer.extraction_id, oer.document_id, oer.overall_confidence,
             oer.review_status, oer.critical_flags,
             oer.invoice_number, oer.invoice_date,
             oer.vendor_name, oer.vendor_gstin, oer.gross_total,
             oer.matched_vendor_score, oer.is_new_vendor,
             oer.suggested_ledger_name, oer.suggested_ledger_confidence,
             oer.draft_transaction_id,
             ud.original_filename, ud.entity_type, ud.upload_status,
             ud.uploaded_at
           FROM ocr_extraction_results oer
           JOIN uploaded_documents ud ON ud.document_id = oer.document_id
           WHERE oer.tenant_id = $1
             AND oer.review_status IN ('PENDING_REVIEW', 'FLAGGED', 'AMENDED')
           ORDER BY oer.overall_confidence ASC, oer.created_at DESC
           LIMIT 50`,
          [String(req.companyId!)]
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

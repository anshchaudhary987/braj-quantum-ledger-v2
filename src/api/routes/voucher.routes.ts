import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { AppError } from "../auth/auth-service";
import { validate } from "../middleware/validate";
import { voucherRateLimiter } from "../middleware/rate-limiter-redis";
import { requireAuth, requireRole, setSecurityContext } from "../auth/auth-middleware";
import { withClient, withTransaction } from "../../db/pool";
import { TransactionManager } from "../../services/transaction-manager";
import { InventoryService } from "../../inventory/inventory-service";
import { TaxCalculator } from "../../gst/tax-calculator";
import { VoucherFactory } from "../../vouchers/voucher-factory";
import { SalesVoucherStrategy } from "../../vouchers/sales-voucher";
import {
  SalesVoucherRequest,
  SalesVoucherResponse,
  SalesVoucherLineResponse,
} from "../types";
import { ErrorCode } from "../errors";
import { PoolClient } from "pg";

const router = Router();
const canCreateVouchers = requireRole("OWNER", "ADMIN", "ACCOUNTANT", "SALES_USER");

VoucherFactory.register(new SalesVoucherStrategy());

// ---------------------------------------------------------------------------
// Zod validation schema for the Sales Voucher request
// ---------------------------------------------------------------------------
const salesVoucherSchema = z.object({
  body: z.object({
    header: z.object({
      voucher_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD."),
      customer_account_id: z.number().int().positive(),
      reference_number: z.string().max(50).optional(),
      place_of_supply_state: z.string().length(2, "State code must be exactly 2 digits."),
      narration: z.string().max(500).optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    line_items: z.array(
      z.object({
        stock_item_id: z.number().int().positive(),
        description: z.string().max(500).optional(),
        quantity: z.number().positive("Quantity must be positive."),
        uom_id: z.number().int().positive(),
        rate: z.number().min(0, "Rate cannot be negative."),
        discount_percent: z.number().min(0).max(100).optional(),
        discount_amount: z.number().min(0).optional(),
        hsn_sac_code: z.string().min(4),
        godown_id: z.number().int().positive(),
        batch_id: z.number().int().positive().optional(),
        serial_numbers: z.array(z.number().int().positive()).optional(),
      })
    ).min(1, "At least one line item is required."),
    tax_details: z.object({
      counterparty_gstin: z.string().length(15).optional(),
      is_rcm_applicable: z.boolean().optional(),
    }),
    idempotency_key: z.string().uuid("Idempotency key must be a valid UUID."),
  }),
});

// ---------------------------------------------------------------------------
// POST /api/v1/vouchers/sales
//
// This endpoint demonstrates the full flow:
//   Auth → Validation → Accounting → Inventory → GST → Tax Entries
// All within a single database transaction.
// ---------------------------------------------------------------------------
router.post(
  "/sales",
  requireAuth,
  canCreateVouchers,
  voucherRateLimiter,
  validate(salesVoucherSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: SalesVoucherRequest = req.body;

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const txnMgr     = new TransactionManager(client);
          const inventory  = new InventoryService(client);
          const taxCalc    = new TaxCalculator(client);

          // ---- STEP 1: Compute totals ----
          let grossAmount   = 0;
          let totalDiscount = 0;
          const lineCalcs   = [];

          for (const line of input.line_items) {
            const lineAmount = line.quantity * line.rate;
            const discount   = line.discount_amount ??
              (line.discount_percent ? lineAmount * line.discount_percent / 100 : 0);

            grossAmount   += lineAmount;
            totalDiscount += discount;

            lineCalcs.push({
              ...line,
              line_amount: lineAmount,
              discount,
              taxable_value: lineAmount - discount,
            });
          }

          // ---- STEP 2: Calculate GST ----
          const companyGstRegistration = await client.query<{ gstin: string }>(
            `SELECT gstin FROM gst_registrations WHERE company_id = $1 LIMIT 1`,
            [req.companyId!]
          );
          const companyGstin = companyGstRegistration.rows[0]?.gstin;

          if (!companyGstin) {
            throw new AppError(ErrorCode.INVALID_GSTIN, "Company GST registration not found.");
          }

          // Tax on the overall taxable value (simplified — per-line in production)
          const totalTaxable = grossAmount - totalDiscount;
          const line0 = input.line_items[0]; // representative HSN

          const taxResult = await taxCalc.calculate({
            transaction_id: 0, // placeholder; assigned after insert
            tax_type: "OUTPUT",
            company_gstin: companyGstin,
            counterparty_gstin: input.tax_details.counterparty_gstin,
            hsn_sac_code: line0.hsn_sac_code,
            taxable_value: totalTaxable,
            place_of_supply_state_code: input.header.place_of_supply_state,
            is_rcm_applicable: input.tax_details.is_rcm_applicable,
          });

          const grandTotal = totalTaxable + taxResult.total_tax;

          // ---- STEP 3: Create the accounting transaction ----
          // Debit: Customer Account  |  Credit: Sales Revenue + Tax Payable accounts
          const txnResult = await txnMgr.create({
            idempotency_key: input.idempotency_key,
            tenant_id: String(req.companyId!),
            txn_date: input.header.voucher_date,
            description: `Sales Voucher — ${input.header.reference_number ?? "N/A"} — ${input.header.narration ?? ""}`,
            voucher_type: "SALES_VOUCHER",
            voucher_payload: {
              customer_account_id: input.header.customer_account_id,
              gross_amount: grossAmount,
              discount: totalDiscount,
              taxable_value: totalTaxable,
              tax_amount: taxResult.total_tax,
              grand_total: grandTotal,
              tax_components: taxResult.components,
              line_items: lineCalcs,
            },
            metadata: input.header.metadata ?? {},
          });

          // ---- STEP 4: Create stock movements for each line ----
          const stockMovements = [];
          for (const line of lineCalcs) {
            const stockResult = await inventory.recordMovement(
              {
                transaction_type: "SALES",
                item_id: line.stock_item_id,
                godown_id: line.godown_id,
                quantity: line.quantity,
                uom_id: line.uom_id,
                rate: line.rate,
                amount: line.line_amount,
                narration: line.description,
                batch_allocations: line.batch_id
                  ? [{ batch_id: line.batch_id, quantity: line.quantity }]
                  : undefined,
                serial_numbers: line.serial_numbers,
              },
              txnResult.transactionId
            );
            stockMovements.push(stockResult);
          }

          // ---- STEP 5: Persist tax entries ----
          await taxCalc.persistTaxEntries(
            taxResult,
            txnResult.transactionId,
            [], // journalEntryIds — populated by TransactionManager
            input.tax_details.counterparty_gstin,
            extractReturnPeriod(input.header.voucher_date)
          );

          // ---- STEP 6: Build response ----
          const lineResponses: SalesVoucherLineResponse[] = lineCalcs.map(
            (line, i) => ({
              line_number: i + 1,
              stock_item_id: line.stock_item_id,
              item_name: `Item #${line.stock_item_id}`,
              quantity: line.quantity,
              rate: line.rate,
              amount: line.line_amount,
              discount_amount: line.discount,
              taxable_value: line.taxable_value,
              tax_components: taxResult.components.map((c) => ({
                component: c.component,
                rate: c.tax_rate,
                amount: Math.round(c.tax_amount * (line.taxable_value / totalTaxable) * 100) / 100,
              })),
            })
          );

          const response: SalesVoucherResponse = {
            transaction_id: txnResult.transactionId,
            voucher_number: `SLS-${txnResult.transactionId}`,
            voucher_date: input.header.voucher_date,
            customer_name: `Customer #${input.header.customer_account_id}`,
            line_items: lineResponses,
            totals: {
              gross_amount: grossAmount,
              total_discount: totalDiscount,
              taxable_value: totalTaxable,
              total_tax: taxResult.total_tax,
              grand_total: grandTotal,
            },
            tax_summary: taxResult.components.map((c) => ({
              component: c.component,
              rate: c.tax_rate,
              taxable_value: totalTaxable,
              tax_amount: c.tax_amount,
            })),
            stock_movements: stockMovements.map((m) => ({
              stock_txn_id: m.stock_txn_id,
              item_name: "",
              quantity_out: m.quantity_in_base,
            })),
          };

          return response;
        });
      });

      res.status(201).json({
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          version: "1.0",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Helper: extract YYYY-MM from a date string
function extractReturnPeriod(dateStr: string): string {
  const d = new Date(dateStr);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${month}`;
}

export default router;

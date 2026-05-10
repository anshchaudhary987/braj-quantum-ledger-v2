// ============================================================================
// PURCHASE INVOICE VOUCHER STRATEGY — DRAFT → HUMAN REVIEW → APPROVE
//
// Translates OCR-extracted purchase invoice data into a DRAFT journal entry.
// The entry does NOT affect the Trial Balance until a human approves it.
//
// Debit side:
//   Dr Expense Ledger A/c (suggested or confirmed)   — Net taxable value
//   Dr CGST Input A/c                                 — CGST amount
//   Dr SGST Input A/c                                 — SGST amount
//   Dr IGST Input A/c                                 — IGST amount
//
// Credit side:
//   Cr Vendor / Sundry Creditor A/c                   — Gross total
//
// Expected payload:
// {
//   expense_ledger_id: number,      // Account to debit for the expense
//   vendor_account_id: number,      // Vendor's ledger account (Sundry Creditor)
//   taxable_value: number,
//   cgst_amount: number,
//   sgst_amount: number,
//   igst_amount: number,
//   cess_amount: number,
//   gross_total: number,
//   invoice_number: string,
//   invoice_date: string,
//   vendor_gstin: string,
//   vendor_name: string,
//   is_draft: boolean,              // true for AI-generated vouchers
//   line_items_json?: string,       // JSON string of line items
//   extraction_id?: number,
// }
//
// The TransactionManager handles the core flow:
//   1. Insert transaction with metadata.is_draft = true
//   2. Insert journal_entries
//   3. The account_balances trigger excludes is_draft transactions
//
// ON APPROVAL: The service sets metadata.is_draft = false, which causes
// the account_balances trigger to include the transaction in balances.
// ============================================================================

import { PoolClient } from "pg";
import { VoucherStrategy } from "./voucher-strategy";
import { JournalLine, VoucherPayload } from "../models/types";

export class PurchaseInvoiceVoucherStrategy implements VoucherStrategy {
  readonly voucherType = "PURCHASE_INVOICE_VOUCHER";

  async translate(
    _client: PoolClient,
    payload: VoucherPayload,
    _tenantId: string,
    _txnDate: string
  ): Promise<JournalLine[]> {
    const expenseLedgerId  = Number(payload.expense_ledger_id);
    const vendorAccountId  = Number(payload.vendor_account_id);
    const cgstInputId      = Number(payload.cgst_input_account_id ?? 0);
    const sgstInputId      = Number(payload.sgst_input_account_id ?? 0);
    const igstInputId      = Number(payload.igst_input_account_id ?? 0);
    const cessInputId      = Number(payload.cess_input_account_id ?? 0);

    const taxableValue = Number(payload.taxable_value);
    const cgstAmt      = Number(payload.cgst_amount);
    const sgstAmt      = Number(payload.sgst_amount);
    const igstAmt      = Number(payload.igst_amount);
    const cessAmt      = Number(payload.cess_amount);
    const grossTotal   = Number(payload.gross_total);
    const invoiceNo    = String(payload.invoice_number ?? "OCR-IMPORTED");
    const vendorName   = String(payload.vendor_name ?? "Unknown Vendor");

    if (!expenseLedgerId || !vendorAccountId || taxableValue <= 0) {
      throw new Error("PURCHASE_INVOICE_VOUCHER requires expense_ledger_id, vendor_account_id, and taxable_value > 0");
    }

    const narration = `Purchase: ${invoiceNo} — ${vendorName} [DRAFT]`;

    const lines: JournalLine[] = [
      // ── DEBIT: Expense ──
      {
        account_id: expenseLedgerId,
        debit_amount: taxableValue,
        credit_amount: 0,
        description: `${narration} — Taxable Value`,
      },
    ];

    // ── DEBIT: Input Tax (optional, only if amounts > 0) ──
    if (cgstAmt > 0 && cgstInputId > 0) {
      lines.push({
        account_id: cgstInputId,
        debit_amount: cgstAmt,
        credit_amount: 0,
        description: `${narration} — CGST Input`,
      });
    }
    if (sgstAmt > 0 && sgstInputId > 0) {
      lines.push({
        account_id: sgstInputId,
        debit_amount: sgstAmt,
        credit_amount: 0,
        description: `${narration} — SGST Input`,
      });
    }
    if (igstAmt > 0 && igstInputId > 0) {
      lines.push({
        account_id: igstInputId,
        debit_amount: igstAmt,
        credit_amount: 0,
        description: `${narration} — IGST Input`,
      });
    }
    if (cessAmt > 0 && cessInputId > 0) {
      lines.push({
        account_id: cessInputId,
        debit_amount: cessAmt,
        credit_amount: 0,
        description: `${narration} — Cess Input`,
      });
    }

    // ── CREDIT: Vendor ──
    lines.push({
      account_id: vendorAccountId,
      debit_amount: 0,
      credit_amount: grossTotal,
      description: `${narration} — Payable to ${vendorName}`,
    });

    return lines.filter((l) => l.debit_amount > 0 || l.credit_amount > 0);
  }
}
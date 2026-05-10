import { PoolClient } from "pg";
import { TcsCalculationInput, TcsCalculationResult, TcsEntryRow } from "./tds-types.js";
import { TdsDeductionEngine } from "./tds-deduction-engine.js";

// ---------------------------------------------------------------------------
// TCS ENGINE — Tax Collected at Source (Section 206C(1H))
// ---------------------------------------------------------------------------
//
// Section 206C(1H): Effective 1st Oct 2020
//   - 0.1% TCS on sale of GOODS exceeding ₹50 Lakhs in a FY from a single buyer
//   - TCS collected on the invoice itself (added to invoice)
//   - If buyer PAN is missing → 1% TCS instead of 0.1%
//   - The threshold of ₹50L is on RECEIPTS (not invoices)
//   - If seller turnover < ₹10 Crores in previous year → exempt
//
// Algorithm:
//   For each sales invoice to a buyer:
//     1. Check if seller's turnover qualifies (≥ ₹10 Cr in PY)
//     2. Get cumulative receipts from this buyer in the current FY
//     3. If cumulative + this_invoice > ₹50,00,000:
//        a. TCS applies on the EXCESS over ₹50L
//        b. Determine rate: 0.1% (with PAN) or 1% (without PAN)
//        c. Add TCS to the invoice: Debit Buyer, Credit TCS Payable
//        d. Record tcs_entry
//     4. Update cumulative receipts tracker
// ---------------------------------------------------------------------------

export class TcsEngine {
  private readonly TCS_THRESHOLD = 50_00_000;   // ₹50 Lakhs
  private readonly TCS_RATE = 0.10;              // 0.1%
  private readonly TCS_RATE_NO_PAN = 1.00;       // 1%

  constructor(private readonly client: PoolClient) {}

  /**
   * Calculate TCS on a sales invoice.
   * Called during Sales Voucher creation, after journal entries are built.
   */
  async calculateTcs(
    input: TcsCalculationInput,
    companyId: number
  ): Promise<TcsCalculationResult> {
    // 1. Check seller turnover exemption (simplified — use a config flag)
    // In production, check previous year's turnover from the company master

    // 2. Get buyer PAN
    const { rows: panRows } = await this.client.query<{
      pan_number: string; pan_status: string;
    }>(
      `SELECT pan_number, pan_status
       FROM tds_pan_details
       WHERE account_id = $1 AND company_id = $2`,
      [input.buyer_account_id, companyId]
    );

    const buyerPan = panRows[0]?.pan_number ?? null;
    const hasValidPan = buyerPan && panRows[0]?.pan_status === "VERIFIED";
    const tcsRate = hasValidPan ? this.TCS_RATE : this.TCS_RATE_NO_PAN;

    // 3. Get cumulative receipts from this buyer in the current FY
    const fy = this.getFinancialYear(input.voucher_date);

    const { rows: cumRows } = await this.client.query<{ total: string }>(
      `SELECT COALESCE(SUM(je.credit_amount), 0)::TEXT AS total
       FROM journal_entries je
       JOIN transactions t ON t.transaction_id = je.transaction_id
       WHERE je.account_id = $1
         AND t.company_id  = $2
         AND t.txn_date >= $3::DATE
         AND t.txn_date <= $4::DATE
         AND je.credit_amount > 0`,
      [input.buyer_account_id, companyId,
       `${fy}-04-01`, input.voucher_date]
    );

    const cumulativeBefore = Number(cumRows[0]?.total ?? 0);
    const cumulativeAfter  = cumulativeBefore + input.invoice_amount;

    // 4. Check if threshold is crossed
    if (cumulativeAfter <= this.TCS_THRESHOLD) {
      return {
        tcs_applicable: false,
        tcs_amount: 0,
        tcs_rate: tcsRate,
        cumulative_before: cumulativeBefore,
        amount_exceeding_50l: null,
        reason_if_skipped: `Cumulative receipts (₹${cumulativeAfter.toLocaleString('en-IN')}) do not exceed ₹50,00,000. TCS will apply when this buyer's purchases cross ₹50L.`,
      };
    }

    // 5. Compute TCS on the EXCESS
    const amountExceeding = cumulativeAfter - this.TCS_THRESHOLD;
    const tcsAmount = Math.round(amountExceeding * tcsRate / 100 * 100) / 100;

    // Only apply TCS on the excess that falls in *this* invoice
    // (if cumulativeBefore already exceeded ₹50L, apply on full invoice)
    const tcsOnThisInvoice = cumulativeBefore >= this.TCS_THRESHOLD
      ? Math.round(input.invoice_amount * tcsRate / 100 * 100) / 100
      : tcsAmount;

    return {
      tcs_applicable: true,
      tcs_amount: tcsOnThisInvoice,
      tcs_rate: tcsRate,
      cumulative_before: cumulativeBefore,
      amount_exceeding_50l: amountExceeding,
    };
  }

  /**
   * Record the TCS entry after the voucher is committed.
   * Modifies the transaction to add: Debit Buyer (TCS), Credit TCS Payable.
   */
  async recordTcs(
    transactionId: number,
    buyerAccountId: number,
    tcsAmount: number,
    tcsRate: number,
    companyId: number
  ): Promise<number> {
    const returnPeriod = new Date().toISOString().substring(0, 7);

    // Insert TCS journal lines
    await this.client.query(
      `INSERT INTO journal_entries
         (transaction_id, account_id, debit_amount, credit_amount, description)
       VALUES ($1, $2, $3, 0, $4),
              ($1, $5, 0, $6, $7)`,
      [transactionId,
       buyerAccountId, tcsAmount, 'TCS on Sales u/s 206C(1H) — Debit Buyer',
       0, tcsAmount, 'TCS on Sales u/s 206C(1H) — Credit TCS Payable']
    );

    // Record TCS entry
    const { rows: buyerRows } = await this.client.query<{ pan_number: string; pan_status: string }>(
      `SELECT pan_number, pan_status FROM tds_pan_details WHERE account_id = $1`,
      [buyerAccountId]
    );

    const { rows } = await this.client.query<TcsEntryRow>(
      `INSERT INTO tcs_entries
         (company_id, transaction_id, buyer_account_id, section_code,
          cumulative_receipts_before, amount_exceeding_50l, tcs_rate, tcs_amount,
          buyer_pan, buyer_pan_status, return_period)
       VALUES ($1, $2, $3, '206C(1H)', $4, $5, $6, $7, $8, $9, $10)
       RETURNING tcs_entry_id`,
      [companyId, transactionId, buyerAccountId,
       0, 0, tcsRate, tcsAmount,
       buyerRows[0]?.pan_number ?? null, buyerRows[0]?.pan_status ?? null,
       returnPeriod]
    );

    return rows[0].tcs_entry_id;
  }

  private getFinancialYear(dateStr: string): number {
    const d = new Date(dateStr);
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  }
}

import { PoolClient } from "pg";
import {
  TdsSectionRow,
  TdsSectionRateRow,
  TdsPanDetailRow,
  TdsLowerCertRow,
  TdsThresholdTrackerRow,
  TdsDeductionInput,
  TdsDeductionResult,
} from "./tds-types";
import { AppError } from "../api/auth/auth-service";
import { ErrorCode } from "../api/errors";

// ---------------------------------------------------------------------------
// TDS AUTO-DEDUCTION ENGINE
// ---------------------------------------------------------------------------

export class TdsDeductionEngine {
  constructor(private readonly client: PoolClient) {}

  /**
   * CORE ALGORITHM — Automatically compute TDS and inject into journal entries.
   *
   * Logic:
   *   1. Load the TDS section (e.g. 194C)
   *   2. Find the vendor's PAN details + deductee type
   *   3. Check for valid lower deduction certificate (u/s 197)
   *   4. Determine applicable TDS rate:
   *      a. Lower deduction cert → cert's rate (or nil)
   *      b. PAN invalid/missing → 20% (or section's rate, whichever higher)
   *      c. Normal → section's rate for deductee type
   *   5. Check thresholds:
   *      a. If single_bill_threshold exists AND gross_amount ≤ it → SKIP
   *      b. Load threshold_tracker for this vendor + section + FY
   *      c. If (cumulative + this_gross) ≤ aggregate_yearly_threshold → SKIP (but update tracker)
   *      d. If threshold crossed → TDS APPLIES on ENTIRE taxable_amount
   *   6. Compute TDS = taxable_amount × rate + surcharge + cess
   *   7. Record tds_entry, update tracker
   */
  async computeDeduction(
    input: TdsDeductionInput,
    companyId: number,
    tdsPayableAccountId: number   // TDS Payable ledger (e.g., 'TDS Payable 194C')
  ): Promise<TdsDeductionResult> {
    // ---- Step 1: Load TDS section ----
    const { rows: sectionRows } = await this.client.query<TdsSectionRow>(
      `SELECT * FROM tds_sections
       WHERE section_code = $1 AND is_active = TRUE
         AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`,
      [input.section_code]
    );

    const section = sectionRows[0];
    if (!section) {
      throw new AppError(ErrorCode.NOT_FOUND, `TDS section ${input.section_code} not found.`);
    }

    // ---- Step 2: Vendor PAN + deductee type ----
    const panInfo = await this.getPanDetails(input.vendor_account_id, companyId);

    // ---- Step 3: Check lower deduction certificate ----
    const cert = await this.getActiveLowerCert(
      input.vendor_account_id, section.section_id, input.voucher_date
    );

    let tdsRate: number;
    let rateSource: string;
    let isNilDeduction = false;

    if (cert) {
      if (cert.is_nil_deduction) {
        isNilDeduction = true;
        tdsRate = 0;
        rateSource = "NIL_DEDUCTION";
      } else {
        tdsRate = Number(cert.lower_tds_rate ?? 0);
        rateSource = "LOWER_DEDUCTION_CERT";
      }
    } else if (!panInfo || panInfo.pan_status === "NOT_AVAILABLE" || panInfo.pan_status === "INVALID") {
      // No valid PAN → 20% (or section rate, whichever is higher)
      tdsRate = Math.max(Number(section.default_tds_rate), 20);
      rateSource = "NO_PAN_20_PCT";
    } else {
      // Normal: lookup rate for deductee type
      tdsRate = await this.getRateForDeductee(section.section_id, panInfo.deductee_type);
      if (tdsRate === 0) {
        tdsRate = Number(section.default_tds_rate);
      }
      rateSource = "SECTION_DEFAULT";
    }

    // ---- Step 4: Threshold Check ----
    const fy = this.getFinancialYear(input.voucher_date);
    const singleThreshold = Number(section.single_bill_threshold ?? 0);
    const aggregateThreshold = Number(section.aggregate_yearly_threshold ?? 0);

    // 4a: Single bill threshold
    if (singleThreshold > 0 && input.taxable_amount <= singleThreshold) {
      return {
        tds_applicable: false,
        section_code: section.section_code,
        tds_rate: tdsRate,
        tds_amount: 0,
        total_tds: 0,
        rate_source: rateSource,
        threshold_crossed: false,
        reason_if_skipped: `Taxable amount (₹${input.taxable_amount}) does not exceed single bill threshold (₹${singleThreshold}).`,
      };
    }

    // 4b: Aggregate yearly threshold
    const tracker = await this.getOrCreateTracker(
      section.section_id, input.vendor_account_id, fy, companyId
    );

    const cumulativeBefore = Number(tracker.cumulative_taxable_amount);
    const cumulativeAfter   = cumulativeBefore + input.taxable_amount;

    if (aggregateThreshold > 0 && cumulativeAfter <= aggregateThreshold) {
      // Threshold not yet crossed → update tracker but don't deduct TDS
      await this.updateTracker(tracker.tracker_id, cumulativeAfter, 0, input.transaction_id, input.voucher_date);

      return {
        tds_applicable: false,
        section_code: section.section_code,
        tds_rate: tdsRate,
        tds_amount: 0,
        total_tds: 0,
        rate_source: rateSource,
        threshold_crossed: false,
        reason_if_skipped: `Cumulative amount (₹${cumulativeAfter}) does not exceed aggregate threshold (₹${aggregateThreshold}). TDS will apply on the NEXT bill if it crosses.`,
      };
    }

    // ---- Step 5: TDS APPLIES — Compute ----
    let tdsAmount = 0;
    let totalTds  = 0;

    if (!isNilDeduction) {
      tdsAmount = Math.round(input.taxable_amount * tdsRate / 100 * 100) / 100;

      // Surcharge (applied on TDS amount, not on taxable)
      const surchargeRate = Number(section.surcharge_rate);
      const surcharge = surchargeRate > 0
        ? Math.round(tdsAmount * surchargeRate / 100 * 100) / 100
        : 0;

      // Health & Education Cess (on TDS + surcharge)
      const cessRate = Number(section.health_education_cess);
      const cess = cessRate > 0
        ? Math.round((tdsAmount + surcharge) * cessRate / 100 * 100) / 100
        : 0;

      totalTds = tdsAmount + surcharge + cess;
    }

    // ---- Step 6: Inject journal entries ----
    // Split the vendor credit line: Vendor Net + TDS Payable
    const vendorGrossAmount = input.taxable_amount; // the credit to vendor before TDS
    const vendorNetAmount   = vendorGrossAmount - totalTds;

    // Update the vendor line to be the net amount
    await this.client.query(
      `UPDATE journal_entries
       SET credit_amount = $1,
           description = COALESCE(description, '') || ' (Net of TDS u/s ' || $2 || ')'
       WHERE entry_id = $3`,
      [vendorNetAmount, section.section_code, input.journal_entry_ids.vendor_line_id]
    );

    // Insert the TDS Payable line
    const { rows: tdsJeRows } = await this.client.query<{ entry_id: number }>(
      `INSERT INTO journal_entries
         (transaction_id, account_id, debit_amount, credit_amount, description)
       VALUES ($1, $2, 0, $3, $4)
       RETURNING entry_id`,
      [input.transaction_id, tdsPayableAccountId, totalTds,
       `TDS u/s ${section.section_code} @ ${tdsRate}% on ₹${input.taxable_amount} (PAN: ${panInfo?.pan_number ?? 'N/A'})`]
    );

    // ---- Step 7: Record TDS entry ----
    const returnPeriod = this.getReturnPeriod(input.voucher_date);

    const { rows: tdsRows } = await this.client.query<{ tds_entry_id: number }>(
      `INSERT INTO tds_entries
         (company_id, transaction_id, journal_entry_id, section_id, vendor_account_id,
          gross_amount, taxable_amount, tds_rate, tds_amount,
          surcharge_amount, cess_amount, total_tds,
          deductee_pan, deductee_pan_status, deductee_type,
          rate_source, lower_deduction_cert_id,
          return_period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING tds_entry_id`,
      [companyId, input.transaction_id, tdsJeRows[0].entry_id,
       section.section_id, input.vendor_account_id,
       input.gross_amount, input.taxable_amount, tdsRate, tdsAmount,
       0, 0, totalTds,
       panInfo?.pan_number ?? null, panInfo?.pan_status ?? null, panInfo?.deductee_type ?? null,
       rateSource, cert?.cert_id ?? null,
       returnPeriod]
    );

    // ---- Step 8: Update threshold tracker ----
    await this.updateTracker(
      tracker.tracker_id, cumulativeAfter, totalTds, input.transaction_id, input.voucher_date
    );

    return {
      tds_applicable: true,
      tds_entry_id: tdsRows[0].tds_entry_id,
      section_code: section.section_code,
      tds_rate: tdsRate,
      tds_amount: tdsAmount,
      total_tds: totalTds,
      rate_source: rateSource,
      threshold_crossed: true,
    };
  }

  // -----------------------------------------------------------------------
  // HELPERS
  // -----------------------------------------------------------------------
  private async getPanDetails(
    accountId: number, companyId: number
  ): Promise<TdsPanDetailRow | null> {
    const { rows } = await this.client.query<TdsPanDetailRow>(
      `SELECT * FROM tds_pan_details WHERE account_id = $1 AND company_id = $2`,
      [accountId, companyId]
    );
    return rows[0] ?? null;
  }

  private async getActiveLowerCert(
    accountId: number, sectionId: number, voucherDate: string
  ): Promise<TdsLowerCertRow | null> {
    const { rows } = await this.client.query<TdsLowerCertRow>(
      `SELECT * FROM tds_lower_deduction_certs
       WHERE account_id = $1 AND section_id = $2
         AND is_active = TRUE
         AND valid_from <= $3::DATE AND valid_to >= $3::DATE
       LIMIT 1`,
      [accountId, sectionId, voucherDate]
    );
    return rows[0] ?? null;
  }

  private async getRateForDeductee(
    sectionId: number, deducteeType: string
  ): Promise<number> {
    const { rows } = await this.client.query<TdsSectionRateRow>(
      `SELECT tds_rate FROM tds_section_rates
       WHERE section_id = $1 AND deductee_type = $2 AND is_active = TRUE
       LIMIT 1`,
      [sectionId, deducteeType]
    );
    return rows[0] ? Number(rows[0].tds_rate) : 0;
  }

  private async getOrCreateTracker(
    sectionId: number, vendorAccountId: number, fy: number, companyId: number
  ): Promise<TdsThresholdTrackerRow> {
    const { rows } = await this.client.query<TdsThresholdTrackerRow>(
      `SELECT * FROM tds_threshold_tracker
       WHERE section_id = $1 AND vendor_account_id = $2
         AND financial_year = $3 AND company_id = $4
       LIMIT 1`,
      [sectionId, vendorAccountId, fy, companyId]
    );

    if (rows.length > 0) return rows[0];

    const { rows: newRows } = await this.client.query<TdsThresholdTrackerRow>(
      `INSERT INTO tds_threshold_tracker
         (company_id, section_id, vendor_account_id, financial_year,
          cumulative_taxable_amount, cumulative_tds_deducted)
       VALUES ($1, $2, $3, $4, 0, 0)
       RETURNING *`,
      [companyId, sectionId, vendorAccountId, fy]
    );
    return newRows[0];
  }

  private async updateTracker(
    trackerId: number, cumulativeAmount: number, cumulativeTds: number,
    txnId: number, txnDate: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE tds_threshold_tracker
       SET cumulative_taxable_amount = $1,
           cumulative_tds_deducted   = cumulative_tds_deducted + $2,
           last_transaction_id       = $3,
           last_transaction_date     = $4,
           updated_at                = now()
       WHERE tracker_id = $5`,
      [cumulativeAmount, cumulativeTds, txnId, txnDate, trackerId]
    );
  }

  private getFinancialYear(dateStr: string): number {
    const d = new Date(dateStr);
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  }

  private getReturnPeriod(dateStr: string): string {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}
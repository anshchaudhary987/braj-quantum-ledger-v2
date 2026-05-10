import { PoolClient } from "pg";
import { TaxPaymentRow, Form26QRow } from "./tds-types";
import { AppError } from "../api/auth/auth-service";
import { ErrorCode } from "../api/errors";

// ---------------------------------------------------------------------------
// TDS PAYMENT SERVICE — Challan management + Form 26Q / 24Q
// ---------------------------------------------------------------------------

export class TdsPaymentService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Record a tax deposit challan.
   * Links it to individual TDS entries via the mapping table.
   */
  async recordChallan(
    input: {
      challan_serial_number: string;
      bsr_code: string;
      challan_date: string;
      section_code: string;
      assessment_year: string;
      financial_year: number;
      total_tds_amount: number;
      interest_amount?: number;
      late_fee_amount?: number;
      payment_mode?: string;
      bank_name?: string;
      instrument_number?: string;
      // Array of { tds_entry_id, allocated_amount } to link against
      allocations: Array<{ tds_entry_id: number; allocated_amount: number }>;
      narration?: string;
    },
    companyId: number
  ): Promise<number> {
    // Validate allocation total
    const allocSum = input.allocations.reduce((s, a) => s + a.allocated_amount, 0);
    const expectedTotal = input.total_tds_amount;

    if (Math.abs(allocSum - expectedTotal) > 1) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Allocation sum (₹${allocSum}) does not match challan total (₹${expectedTotal}).`
      );
    }

    const totalPaid = input.total_tds_amount
      + (input.interest_amount ?? 0)
      + (input.late_fee_amount ?? 0);

    // Insert payment record
    const { rows } = await this.client.query<TaxPaymentRow>(
      `INSERT INTO tax_payments
         (company_id, payment_type, challan_serial_number, bsr_code,
          challan_date, section_code, assessment_year, financial_year,
          total_tds_amount, interest_amount, late_fee_amount, total_paid,
          payment_mode, bank_name, instrument_number,
          narration)
       VALUES ($1, 'TDS', $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING payment_id`,
      [companyId, input.challan_serial_number, input.bsr_code,
       input.challan_date, input.section_code, input.assessment_year,
       input.financial_year,
       input.total_tds_amount, input.interest_amount ?? 0,
       input.late_fee_amount ?? 0, totalPaid,
       input.payment_mode ?? "ONLINE", input.bank_name ?? null,
       input.instrument_number ?? null, input.narration ?? null]
    );

    const paymentId = rows[0].payment_id;

    // Insert allocation mappings
    for (const alloc of input.allocations) {
      await this.client.query(
        `INSERT INTO tax_payment_mappings
           (payment_id, tds_entry_id, allocated_amount)
         VALUES ($1, $2, $3)`,
        [paymentId, alloc.tds_entry_id, alloc.allocated_amount]
      );
    }

    return paymentId;
  }

  /**
   * Generate Form 26Q data for a specific return period.
   */
  async getForm26QData(
    companyId: number,
    returnPeriod: string
  ): Promise<{
    period: string;
    total_deductees: number;
    total_tds: number;
    rows: Form26QRow[];
  }> {
    const { rows } = await this.client.query<{
      pan_of_deductee: string | null;
      deductee_name: string;
      section_code: string;
      amount_paid_credited: string;
      tds_rate: string;
      total_tax_deducted: string;
      deduction_date: string;
      challan_serial_number: string | null;
      bsr_code: string | null;
      deposit_date: string | null;
      payment_status: string;
    }>(
      `SELECT * FROM vw_form_26q_data
       WHERE company_id = $1 AND return_period = $2
       ORDER BY deduction_date, section_code`,
      [companyId, returnPeriod]
    );

    const mapped = rows.map((r) => ({
      pan_of_deductee: r.pan_of_deductee,
      deductee_name: r.deductee_name,
      section_code: r.section_code,
      amount_paid_credited: Number(r.amount_paid_credited),
      tds_rate: Number(r.tds_rate),
      total_tax_deducted: Number(r.total_tax_deducted),
      deduction_date: r.deduction_date,
      challan_serial_number: r.challan_serial_number,
      bsr_code: r.bsr_code,
      deposit_date: r.deposit_date,
      payment_status: r.payment_status,
    }));

    return {
      period: returnPeriod,
      total_deductees: new Set(mapped.map(r => r.pan_of_deductee)).size,
      total_tds: mapped.reduce((s, r) => s + r.total_tax_deducted, 0),
      rows: mapped,
    };
  }

  /**
   * Get all unpaid TDS entries (used to know what needs to be deposited).
   */
  async getUnpaidTdsEntries(
    companyId: number,
    sectionCode?: string,
    returnPeriod?: string
  ): Promise<Array<{
    tds_entry_id: number;
    vendor_name: string;
    deductee_pan: string | null;
    total_tds: number;
    deduction_date: string;
    section_code: string;
  }>> {
    const { rows } = await this.client.query<{
      tds_entry_id: number;
      vendor_name: string;
      deductee_pan: string | null;
      total_tds: string;
      deduction_date: string;
      section_code: string;
    }>(
      `SELECT te.tds_entry_id, a.account_name AS vendor_name,
              te.deductee_pan, te.total_tds,
              te.created_at::DATE::TEXT AS deduction_date,
              ts.section_code
       FROM tds_entries te
       JOIN accounts a ON a.account_id = te.vendor_account_id
       JOIN tds_sections ts ON ts.section_id = te.section_id
       LEFT JOIN tax_payment_mappings tpm ON tpm.tds_entry_id = te.tds_entry_id
       WHERE te.company_id = $1
         AND tpm.mapping_id IS NULL
         AND ($2::VARCHAR IS NULL OR ts.section_code = $2)
         AND ($3::VARCHAR IS NULL OR te.return_period = $3)
       ORDER BY te.created_at`,
      [companyId, sectionCode ?? null, returnPeriod ?? null]
    );

    return rows.map(r => ({
      tds_entry_id: r.tds_entry_id,
      vendor_name: r.vendor_name,
      deductee_pan: r.deductee_pan,
      total_tds: Number(r.total_tds),
      deduction_date: r.deduction_date,
      section_code: r.section_code,
    }));
  }
}
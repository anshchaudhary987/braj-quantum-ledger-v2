import { PoolClient } from "pg";
import {
  CreateBillInput,
  CreateBillResult,
  AdjustBillInput,
  AdjustBillResult,
  CreateAdvanceInput,
  CreateAdvanceResult,
  PendingBillView,
  PendingBillsQuery,
  AgingReportRow,
  CreditValidationResult,
  BillReferenceRow,
} from "./billing-types";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// BILL SERVICE — Bill-wise Details (AR/AP Tracking)
// ---------------------------------------------------------------------------

export class BillService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // CREATE BILL (NEW_REF) — For Sales Invoices / Purchase Invoices
  // -----------------------------------------------------------------------
  async createBill(
    input: CreateBillInput,
    companyId: number
  ): Promise<CreateBillResult> {
    // 1. Validate credit limit
    const creditCheck = await this.validateCredit(input.ledger_account_id, input.original_amount, companyId);
    if (!creditCheck.is_valid) {
      throw new AppError(ErrorCode.CONFLICT, creditCheck.warning_message ?? "Credit limit exceeded.");
    }

    // 2. Determine due date (credit_days from party ledger)
    const { rows: acRows } = await this.client.query<{ credit_days: number }>(
      `SELECT credit_days FROM accounts WHERE account_id = $1 AND is_party_ledger = TRUE`,
      [input.ledger_account_id]
    );

    const creditDays = acRows[0]?.credit_days ?? 0;
    const dueDate = this.addDays(input.bill_date, creditDays);

    // 3. Insert the bill reference
    const { rows } = await this.client.query<BillReferenceRow>(
      `INSERT INTO bill_references
         (company_id, transaction_id, journal_entry_id, ledger_account_id,
          reference_type, bill_number, bill_date, due_date, bill_description,
          original_amount, pending_amount, settled_amount, status)
       VALUES ($1, $2, $3, $4, 'NEW_REF', $5, $6, $7, $8, $9, $9, 0, 'PENDING')
       RETURNING *`,
      [
        companyId, input.transaction_id, input.journal_entry_id,
        input.ledger_account_id,
        input.bill_number, input.bill_date, dueDate,
        input.bill_description ?? null,
        input.original_amount,
      ]
    );

    return {
      bill_ref_id: rows[0].bill_ref_id,
      bill_number: input.bill_number,
      due_date: dueDate,
      credit_warning: creditCheck.warning_message ?? undefined,
    };
  }

  // -----------------------------------------------------------------------
  // ADJUST BILL (AGST_REF) — Payment against an existing bill
  // -----------------------------------------------------------------------
  async adjustBill(
    input: AdjustBillInput,
    companyId: number
  ): Promise<AdjustBillResult> {
    // 1. Load the original bill and lock the row
    const { rows: billRows } = await this.client.query<BillReferenceRow>(
      `SELECT * FROM bill_references
       WHERE bill_ref_id       = $1
         AND ledger_account_id = $2
         AND company_id        = $3
         AND reference_type    = 'NEW_REF'
       FOR UPDATE`,
      [input.bill_ref_id, input.ledger_account_id, companyId]
    );

    const bill = billRows[0];
    if (!bill) {
      throw new AppError(ErrorCode.NOT_FOUND, "Bill not found.");
    }

    if (bill.status === "SETTLED" || bill.status === "CANCELLED") {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Bill ${bill.bill_number} is already ${bill.status.toLowerCase()}.`
      );
    }

    const pendingAmount = Number(bill.pending_amount);
    const adjustAmount  = input.adjustment_amount;

    // 2. Validate: cannot adjust more than pending
    if (adjustAmount > pendingAmount) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Adjustment amount (₹${adjustAmount}) exceeds pending amount (₹${pendingAmount}) for bill ${bill.bill_number}.`,
        {
          bill_ref_id: bill.bill_ref_id,
          bill_number: bill.bill_number,
          pending_amount: pendingAmount,
          attempted_adjustment: adjustAmount,
        }
      );
    }

    const newPending = pendingAmount - adjustAmount;
    const newSettled = Number(bill.settled_amount) + adjustAmount;
    const isSettled  = newPending <= 0.005; // floating-point tolerance
    const newStatus  = isSettled ? "SETTLED" : "PARTIALLY_PAID";

    // 3. Update the original bill
    await this.client.query(
      `UPDATE bill_references
       SET pending_amount = $1,
           settled_amount = $2,
           status         = $3,
           updated_at     = now()
       WHERE bill_ref_id = $4`,
      [newPending, newSettled, newStatus, bill.bill_ref_id]
    );

    // 4. Insert the adjustment reference (AGST_REF) for audit trail
    await this.client.query(
      `INSERT INTO bill_references
         (company_id, transaction_id, journal_entry_id, ledger_account_id,
          reference_type, adjusted_against_bill_ref_id, adjustment_amount,
          original_amount, pending_amount, status)
       VALUES ($1, $2, $3, $4,
               'AGST_REF', $5, $6,
               0, 0, 'SETTLED')`,
      [
        companyId, input.transaction_id, input.journal_entry_id,
        input.ledger_account_id,
        bill.bill_ref_id, adjustAmount,
      ]
    );

    return {
      bill_ref_id: bill.bill_ref_id,
      bill_number: bill.bill_number ?? "",
      previous_pending: pendingAmount,
      adjustment_amount: adjustAmount,
      new_pending: newPending,
      is_settled: isSettled,
    };
  }

  // -----------------------------------------------------------------------
  // CREATE ADVANCE — Money received/paid before the bill
  // -----------------------------------------------------------------------
  async createAdvance(
    input: CreateAdvanceInput,
    companyId: number
  ): Promise<CreateAdvanceResult> {
    const { rows } = await this.client.query<BillReferenceRow>(
      `INSERT INTO bill_references
         (company_id, transaction_id, journal_entry_id, ledger_account_id,
          reference_type, bill_description,
          original_amount, pending_amount, settled_amount,
          is_advance_available, status)
       VALUES ($1, $2, $3, $4,
               'ADVANCE', $5,
               $6, $6, 0,
               TRUE, 'ADVANCE_PENDING')
       RETURNING *`,
      [
        companyId, input.transaction_id, input.journal_entry_id,
        input.ledger_account_id,
        input.description ?? "Advance received",
        input.advance_amount,
      ]
    );

    return {
      bill_ref_id: rows[0].bill_ref_id,
      advance_amount: input.advance_amount,
      is_available: true,
    };
  }

  /**
   * Consume an advance against a new bill.
   * Called when creating a Sales Invoice for a customer who has an advance.
   * Reduces the advance's pending_amount and the bill's effective receivable.
   */
  async consumeAdvance(
    advanceBillRefId: number,
    newBillAmount: number,
    companyId: number
  ): Promise<{
    advance_consumed: number;
    remaining_bill_amount: number;
    advance_fully_consumed: boolean;
  }> {
    const { rows: advRows } = await this.client.query<BillReferenceRow>(
      `SELECT * FROM bill_references
       WHERE bill_ref_id          = $1
         AND company_id           = $2
         AND reference_type       = 'ADVANCE'
         AND is_advance_available = TRUE
         AND status               = 'ADVANCE_PENDING'
       FOR UPDATE`,
      [advanceBillRefId, companyId]
    );

    const adv = advRows[0];
    if (!adv) {
      throw new AppError(ErrorCode.NOT_FOUND, "Advance not found or already consumed.");
    }

    const availableAdvance = Number(adv.pending_amount);
    const consumed         = Math.min(availableAdvance, newBillAmount);
    const remainingPending = availableAdvance - consumed;

    await this.client.query(
      `UPDATE bill_references
       SET pending_amount      = $1,
           status               = CASE WHEN $1 <= 0 THEN 'ADVANCE_CONSUMED' ELSE 'ADVANCE_PENDING' END,
           is_advance_available = CASE WHEN $1 <= 0 THEN FALSE ELSE TRUE END,
           updated_at           = now()
       WHERE bill_ref_id = $2`,
      [remainingPending, advanceBillRefId]
    );

    return {
      advance_consumed: consumed,
      remaining_bill_amount: newBillAmount - consumed,
      advance_fully_consumed: remainingPending <= 0,
    };
  }

  // -----------------------------------------------------------------------
  // PENDING BILLS — Fetch all open bills for a party (for Agst Ref dropdown)
  // -----------------------------------------------------------------------
  async getPendingBills(query: PendingBillsQuery): Promise<PendingBillView[]> {
    const { rows } = await this.client.query<PendingBillView & {
      party_name: string; party_code: string; days_overdue: string;
    }>(
      `SELECT * FROM vw_pending_bills
       WHERE ledger_account_id = $1 
         AND company_id        = $2
         ${query.include_advances ? "" : "AND reference_type = 'NEW_REF'"}
       ORDER BY due_date ASC`,
      [query.ledger_account_id, query.company_id]
    );

    return rows.map(r => ({
      ...r,
      original_amount: Number(r.original_amount),
      pending_amount: Number(r.pending_amount),
      settled_amount: Number(r.settled_amount),
      days_overdue: Number(r.days_overdue),
    }));
  }

  // -----------------------------------------------------------------------
  // AGING REPORT — Full AR/AP aging for the dashboard
  // -----------------------------------------------------------------------
  async getAgingReport(
    companyId: number,
    asOfDate?: string,
    ledgerAccountId?: number
  ): Promise<{ as_of_date: string; rows: AgingReportRow[] }> {
    const { rows } = await this.client.query(
      `SELECT * FROM get_bill_aging_report($1, $2, $3)`,
      [companyId, asOfDate ?? new Date().toISOString().split("T")[0], ledgerAccountId ?? null]
    );

    return {
      as_of_date: asOfDate ?? new Date().toISOString().split("T")[0],
      rows: rows as unknown as AgingReportRow[],
    };
  }

  // -----------------------------------------------------------------------
  // CREDIT LIMIT VALIDATION
  // -----------------------------------------------------------------------
  async validateCredit(
    ledgerAccountId: number,
    newBillAmount: number,
    companyId: number
  ): Promise<CreditValidationResult> {
    const { rows } = await this.client.query(
      `SELECT * FROM validate_credit_limit($1, $2, $3)`,
      [ledgerAccountId, newBillAmount, companyId]
    );

    return {
      is_valid: Boolean(rows[0]?.is_valid),
      current_exposure: Number(rows[0]?.current_exposure ?? 0),
      credit_limit: Number(rows[0]?.credit_limit ?? 0),
      warning_message: rows[0]?.warning_message ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // BILL HISTORY — All references (original + adjustments) for one bill
  // -----------------------------------------------------------------------
  async getBillHistory(
    billRefId: number,
    companyId: number
  ): Promise<{
    bill: BillReferenceRow;
    adjustments: BillReferenceRow[];
  }> {
    const { rows: billRows } = await this.client.query<BillReferenceRow>(
      `SELECT * FROM bill_references
       WHERE bill_ref_id = $1 AND company_id = $2`,
      [billRefId, companyId]
    );

    if (billRows.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, "Bill not found.");
    }

    const { rows: adjRows } = await this.client.query<BillReferenceRow>(
      `SELECT * FROM bill_references
       WHERE adjusted_against_bill_ref_id = $1 AND company_id = $2
       ORDER BY created_at`,
      [billRefId, companyId]
    );

    return {
      bill: billRows[0],
      adjustments: adjRows,
    };
  }

  // -----------------------------------------------------------------------
  // HELPERS
  // -----------------------------------------------------------------------
  private addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  }
}

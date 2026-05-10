import { PoolClient } from "pg";
import {
  CreateScenarioInput,
  CreateScenarioVoucherInput,
  ScenarioRow,
  ScenarioVoucherRow,
  ScenarioEntryRow,
  PromoteScenarioResult,
} from "./budget-types";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// SCENARIO SERVICE — Provisional Vouchers for Forecasting
// ---------------------------------------------------------------------------
//
// Scenarios are sandboxed "what-if" vouchers. They use parallel tables
// (scenario_vouchers, scenario_entries) that mirror the real transaction/
// journal_entries structure but NEVER touch account_balances, GST returns,
// bank reconciliation, or the real Balance Sheet.
//
// Key operations:
//   1. Create a scenario
//   2. Add vouchers to a scenario
//   3. View scenario P&L / Balance Sheet
//   4. Promote a scenario voucher → real transaction
// ---------------------------------------------------------------------------

export class ScenarioService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // SCENARIOS — CRUD
  // -----------------------------------------------------------------------
  async createScenario(input: CreateScenarioInput, companyId: number): Promise<number> {
    const { rows } = await this.client.query<ScenarioRow>(
      `INSERT INTO scenarios (company_id, scenario_name, description)
       VALUES ($1, $2, $3)
       RETURNING scenario_id`,
      [companyId, input.scenario_name, input.description ?? null]
    );
    return rows[0].scenario_id;
  }

  async listScenarios(companyId: number): Promise<ScenarioRow[]> {
    const { rows } = await this.client.query<ScenarioRow>(
      `SELECT * FROM scenarios
       WHERE company_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC`,
      [companyId]
    );
    return rows;
  }

  // -----------------------------------------------------------------------
  // VOUCHER — Add a provisional entry to a scenario
  // -----------------------------------------------------------------------
  async addVoucher(
    input: CreateScenarioVoucherInput,
    companyId: number
  ): Promise<ScenarioVoucherRow> {
    // Validate double-entry balance
    const totalDebit  = input.entries.reduce((s, e) => s + e.debit_amount, 0);
    const totalCredit = input.entries.reduce((s, e) => s + e.credit_amount, 0);

    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new AppError(
        ErrorCode.DOUBLE_ENTRY_VIOLATION,
        `Scenario voucher is out of balance. Debits: ₹${totalDebit.toFixed(2)}, Credits: ₹${totalCredit.toFixed(2)}.`
      );
    }

    // Insert voucher header
    const { rows: vRows } = await this.client.query<ScenarioVoucherRow>(
      `INSERT INTO scenario_vouchers
         (scenario_id, company_id, voucher_date, description, voucher_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.scenario_id, companyId, input.voucher_date,
       input.description ?? null, input.voucher_type,
       JSON.stringify({})]
    );

    const svId = vRows[0].scenario_voucher_id;

    // Insert entries
    for (const e of input.entries) {
      await this.client.query(
        `INSERT INTO scenario_entries
           (scenario_voucher_id, account_id, debit_amount, credit_amount, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [svId, e.account_id, e.debit_amount, e.credit_amount, e.description ?? null]
      );
    }

    return vRows[0];
  }

  // -----------------------------------------------------------------------
  // PROMOTE — Convert scenario voucher → real transaction
  // -----------------------------------------------------------------------
  async promoteToActual(
    scenarioVoucherId: number,
    companyId: number,
    idempotencyKey: string
  ): Promise<PromoteScenarioResult> {
    // Load the scenario voucher with entries
    const { rows: svRows } = await this.client.query<ScenarioVoucherRow>(
      `SELECT * FROM scenario_vouchers
       WHERE scenario_voucher_id = $1 AND company_id = $2 AND is_promoted = FALSE
       FOR UPDATE`,
      [scenarioVoucherId, companyId]
    );

    const sv = svRows[0];
    if (!sv) {
      throw new AppError(ErrorCode.NOT_FOUND, "Scenario voucher not found or already promoted.");
    }

    const { rows: entryRows } = await this.client.query<ScenarioEntryRow>(
      `SELECT * FROM scenario_entries WHERE scenario_voucher_id = $1 ORDER BY scenario_entry_id`,
      [scenarioVoucherId]
    );

    // Create real transaction
    const { rows: txnRows } = await this.client.query<{ transaction_id: number }>(
      `INSERT INTO transactions (tenant_id, txn_date, description, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING transaction_id`,
      [
        String(companyId),
        sv.voucher_date,
        sv.description ?? "",
        JSON.stringify({
          source: "SCENARIO_PROMOTION",
          scenario_id: sv.scenario_id,
          scenario_voucher_id: sv.scenario_voucher_id,
        }),
      ]
    );

    const txnId = txnRows[0].transaction_id;

    // Create real journal entries
    for (const e of entryRows) {
      await this.client.query(
        `INSERT INTO journal_entries
           (transaction_id, account_id, debit_amount, credit_amount, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [txnId, e.account_id, Number(e.debit_amount),
         Number(e.credit_amount), e.description ?? sv.description ?? ""]
      );
    }

    // Mark scenario voucher as promoted
    await this.client.query(
      `UPDATE scenario_vouchers
       SET is_promoted = TRUE, promoted_transaction_id = $1
       WHERE scenario_voucher_id = $2`,
      [txnId, scenarioVoucherId]
    );

    return {
      scenario_voucher_id: scenarioVoucherId,
      transaction_id: txnId,
      promoted_entries: entryRows.length,
    };
  }

  // -----------------------------------------------------------------------
  // REPORT — Scenario P&L / Trial Balance
  // -----------------------------------------------------------------------
  async getScenarioTrialBalance(
    scenarioId: number
  ): Promise<
    Array<{
      account_id: number;
      account_name: string;
      total_debit: number;
      total_credit: number;
      net_balance: number;
    }>
  > {
    const { rows } = await this.client.query<{
      account_id: string;
      account_name: string;
      total_debit: string;
      total_credit: string;
    }>(
      `SELECT se.account_id,
              a.account_name,
              SUM(se.debit_amount)  AS total_debit,
              SUM(se.credit_amount) AS total_credit
       FROM scenario_vouchers sv
       JOIN scenario_entries se ON se.scenario_voucher_id = sv.scenario_voucher_id
       JOIN accounts a ON a.account_id = se.account_id
       WHERE sv.scenario_id = $1
       GROUP BY se.account_id, a.account_name
       ORDER BY a.account_name`,
      [scenarioId]
    );

    return rows.map((r) => {
      const debit  = Number(r.total_debit);
      const credit = Number(r.total_credit);
      return {
        account_id: Number(r.account_id),
        account_name: r.account_name,
        total_debit: debit,
        total_credit: credit,
        net_balance: debit - credit,
      };
    });
  }
}

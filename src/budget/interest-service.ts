import { PoolClient } from "pg";
import {
  InterestConfigRow,
  InterestProvisionRow,
  ProvisionInterestInput,
  PostInterestProvisionInput,
  CreateBudgetInput,
} from "./budget-types";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// INTEREST SERVICE — Interest calculation + overdue bill provisioning
// ---------------------------------------------------------------------------

export class InterestService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // Interest Config — CRUD
  // -----------------------------------------------------------------------
  async createConfig(
    input: {
      config_name: string;
      interest_type: "SIMPLE" | "COMPOUND";
      rate_per_annum: number;
      compounding_frequency?: "YEARLY" | "QUARTERLY" | "MONTHLY" | "DAILY";
      interest_style?: "30_DAY_MONTH" | "365_DAY_YEAR" | "ACTUAL_DAYS";
      grace_period_days?: number;
      ledger_account_id?: number;
    },
    companyId: number
  ): Promise<number> {
    const { rows } = await this.client.query<InterestConfigRow>(
      `INSERT INTO interest_configs
         (company_id, config_name, interest_type, rate_per_annum,
          compounding_frequency, interest_style, grace_period_days,
          ledger_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING config_id`,
      [
        companyId, input.config_name, input.interest_type, input.rate_per_annum,
        input.compounding_frequency ?? "YEARLY",
        input.interest_style ?? "365_DAY_YEAR",
        input.grace_period_days ?? 0,
        input.ledger_account_id ?? null,
      ]
    );
    return rows[0].config_id;
  }

  // -----------------------------------------------------------------------
  // PROVISION — Calculate and store interest on overdue bills
  // -----------------------------------------------------------------------

  /**
   * Runs the SQL function `provision_overdue_interest()` which:
   *   1. Finds all overdue bills (past due_date + grace_period)
   *   2. Calculates interest using `calculate_interest()` (Simple or Compound)
   *   3. Stores the result in `interest_provisions`
   *   4. Skips bills that were already provisioned today (idempotent)
   */
  async provisionInterest(
    input: ProvisionInterestInput,
    companyId: number
  ): Promise<
    Array<{
      bill_ref_id: number;
      bill_number: string;
      pending_amount: number;
      days_overdue: number;
      calculated_interest: number;
      provision_id: number;
    }>
  > {
    const asOfDate = input.as_of_date ?? new Date().toISOString().split("T")[0];

    const { rows } = await this.client.query<{
      bill_ref_id: string;
      bill_number: string;
      pending_amount: string;
      days_overdue: string;
      calculated_interest: string;
      provision_id: string;
    }>(
      `SELECT * FROM provision_overdue_interest($1, $2, $3)`,
      [companyId, input.config_id, asOfDate]
    );

    return rows.map((r) => ({
      bill_ref_id: Number(r.bill_ref_id),
      bill_number: r.bill_number,
      pending_amount: Number(r.pending_amount),
      days_overdue: Number(r.days_overdue),
      calculated_interest: Number(r.calculated_interest),
      provision_id: Number(r.provision_id),
    }));
  }

  // -----------------------------------------------------------------------
  // POST — Convert a provision into a real accounting voucher
  // -----------------------------------------------------------------------

  /**
   * Posts a single provision: creates a real transaction that debits the
   * party's ledger (Interest Receivable) and credits Interest Income.
   *
   * Math:
   *   Debit  Customer/Party Account  (Interest Receivable)
   *   Credit Interest Income Account (Revenue)
   *
   * After posting, the bill's pending_amount can optionally be updated
   * to include the interest (compound effect) if the config dictates it.
   */
  async postProvision(
    input: PostInterestProvisionInput,
    companyId: number,
    interestIncomeAccountId: number
  ): Promise<{ transaction_id: number; provision_id: number }> {
    // 1. Load the provision
    const { rows: provRows } = await this.client.query<InterestProvisionRow>(
      `SELECT ip.*, br.ledger_account_id
       FROM interest_provisions ip
       JOIN bill_references br ON br.bill_ref_id = ip.bill_ref_id
       WHERE ip.provision_id = $1 AND ip.company_id = $2 AND ip.is_posted = FALSE
       FOR UPDATE`,
      [input.provision_id, companyId]
    );

    const prov = provRows[0];
    if (!prov) {
      throw new AppError(ErrorCode.NOT_FOUND, "Provision not found or already posted.");
    }

    // 2. Create a real accounting transaction
    //    Debit: Party Ledger (adds to receivable)
    //    Credit: Interest Income (revenue)
    const interestAmount = Number(prov.calculated_interest);

    const { rows: txnRows } = await this.client.query<{ transaction_id: number }>(
      `INSERT INTO transactions (tenant_id, txn_date, description, metadata)
       VALUES ($1, CURRENT_DATE, $2, $3)
       RETURNING transaction_id`,
      [
        String(companyId),
        `Interest provision posted — Bill #${prov.bill_ref_id} — ${prov.days_overdue} days @ ${prov.interest_rate}%`,
        JSON.stringify({
          source: "INTEREST_PROVISION",
          provision_id: prov.provision_id,
          bill_ref_id: prov.bill_ref_id,
        }),
      ]
    );

    const txnId = txnRows[0].transaction_id;
    const entries = [
      { account_id: (prov as any).ledger_account_id, debit: interestAmount, credit: 0 },
      { account_id: interestIncomeAccountId, debit: 0, credit: interestAmount },
    ];

    for (const e of entries) {
      await this.client.query(
        `INSERT INTO journal_entries
           (transaction_id, account_id, debit_amount, credit_amount, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [txnId, e.account_id, e.debit, e.credit,
         `Interest on bill #${prov.bill_ref_id}`]
      );
    }

    // 3. Mark provision as posted
    await this.client.query(
      `UPDATE interest_provisions
       SET is_posted = TRUE,
           posted_transaction_id = $1,
           posted_at = now()
       WHERE provision_id = $2`,
      [txnId, prov.provision_id]
    );

    return { transaction_id: txnId, provision_id: prov.provision_id };
  }

  // -----------------------------------------------------------------------
  // QUERIES
  // -----------------------------------------------------------------------

  async getUnpostedProvisions(companyId: number): Promise<InterestProvisionRow[]> {
    const { rows } = await this.client.query<InterestProvisionRow>(
      `SELECT ip.*
       FROM interest_provisions ip
       WHERE ip.company_id = $1 AND ip.is_posted = FALSE
       ORDER BY ip.provision_date DESC`,
      [companyId]
    );
    return rows;
  }

  /**
   * Pure calculation (no DB write) — useful for "what-if" preview
   * before actually provisioning.
   */
  async previewInterest(
    configId: number,
    principal: number,
    daysOverdue: number
  ): Promise<number> {
    const { rows: configRows } = await this.client.query<InterestConfigRow>(
      `SELECT * FROM interest_configs WHERE config_id = $1`,
      [configId]
    );

    const cfg = configRows[0];
    if (!cfg) throw new AppError(ErrorCode.NOT_FOUND, "Interest config not found.");

    const { rows } = await this.client.query<{ interest: string }>(
      `SELECT calculate_interest($1, $2, $3, $4, $5, $6) AS interest`,
      [principal, Number(cfg.rate_per_annum), daysOverdue,
       cfg.interest_type, cfg.interest_style, cfg.compounding_frequency]
    );

    return Number(rows[0].interest);
  }
}

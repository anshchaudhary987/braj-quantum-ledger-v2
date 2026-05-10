// ============================================================================
// FOREX SERVICE — Month-end revaluation (AS-11 compliance)
// ============================================================================
// Logic: Calls the PostgreSQL stored procedure `post_forex_revaluation()`
// which handles the entire AS-11 compliant revaluation workflow.
// ============================================================================

import { PoolClient } from "pg";
import {
  ForexTransaction,
  ExchangeRate,
  ForexRevaluationRun,
  RegisterForexInput,
} from "./forex-types";

export class ForexService {
  constructor(private readonly client: PoolClient) {}

  // -------------------------------------------------------------------
  // MONTH-END REVALUATION (calls stored procedure)
  // -------------------------------------------------------------------

  /**
   * Runs month-end forex revaluation for all open FC receivables/payables.
   *
   * AS-11 rules applied:
   *  - Monetary items (receivables, payables, loans): revalued at closing rate
   *  - Non-monetary items: carried at historical cost (not revalued)
   *  - Exchange differences: recognised in P&L for the period
   *  - Receivable: Rate↑→INR↑→Gain (Credit), Rate↓→Loss (Debit)
   *  - Payable:    Rate↑→INR↑→Loss (Debit),  Rate↓→Gain (Credit)
   *
   * @param companyId  — Tenant company
   * @param revalDate  — Month-end date (e.g., '2026-03-31')
   * @param postedBy   — User ID (0 = SYSTEM for cron)
   */
  async postRevaluation(
    companyId: number,
    revalDate: string,
    postedBy: number = 0
  ): Promise<number> {
    const { rows } = await this.client.query<{ reval_run_id: number }>(
      `SELECT post_forex_revaluation($1, $2::DATE, $3) AS reval_run_id`,
      [companyId, revalDate, postedBy]
    );
    return rows[0].reval_run_id;
  }

  /**
   * Runs revaluation for all months up to the current month.
   * Useful for catching up missed revaluations.
   */
  async backfillRevaluations(
    companyId: number,
    fromDate: string,
    toDate: string
  ): Promise<number[]> {
    const runIds: number[] = [];
    const current = new Date(fromDate);
    const end = new Date(toDate);

    while (current <= end) {
      // Get last day of current month
      const lastDay = new Date(current.getFullYear(), current.getMonth() + 1, 0);

      const runId = await this.postRevaluation(
        companyId,
        lastDay.toISOString().split("T")[0],
        0
      );
      runIds.push(runId);

      // Move to next month
      current.setMonth(current.getMonth() + 1);
      if (current > end) break;
    }

    return runIds;
  }

  // -------------------------------------------------------------------
  // EXCHANGE RATES
  // -------------------------------------------------------------------

  async upsertExchangeRate(
    currencyCode: string,
    rateDate: string,
    rateToInr: number,
    source: string = "RBI_REFERENCE"
  ): Promise<ExchangeRate> {
    const { rows } = await this.client.query<ExchangeRate>(
      `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_inr, source)
       VALUES ($1, $2::DATE, $3, $4)
       ON CONFLICT (currency_code, rate_date)
       DO UPDATE SET rate_to_inr = $3, source = $4, created_at = now()
       RETURNING *`,
      [currencyCode, rateDate, rateToInr, source]
    );
    return rows[0];
  }

  async getRate(currencyCode: string, date: string): Promise<ExchangeRate | null> {
    const { rows } = await this.client.query<ExchangeRate>(
      `SELECT * FROM exchange_rates
       WHERE currency_code = $1 AND rate_date <= $2::DATE
       ORDER BY rate_date DESC
       LIMIT 1`,
      [currencyCode, date]
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------
  // FOREX TRANSACTIONS
  // -------------------------------------------------------------------

  async registerForexTxn(input: RegisterForexInput): Promise<ForexTransaction> {
    const inrEquivalent = parseFloat((input.fc_amount * input.transaction_rate).toFixed(2));

    const { rows } = await this.client.query<ForexTransaction>(
      `INSERT INTO forex_transactions
         (company_id, transaction_id, exposure_type, currency_code, fc_amount,
          transaction_rate, inr_equivalent, counterparty_account_id, counterparty_name,
          transaction_date, due_date, outstanding_fc, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::DATE,$11::DATE,$5,'OPEN')
       RETURNING *`,
      [
        input.company_id, input.transaction_id, input.exposure_type,
        input.currency_code, input.fc_amount, input.transaction_rate,
        inrEquivalent, input.counterparty_account_id,
        input.counterparty_name ?? null, input.transaction_date,
        input.due_date ?? null,
      ]
    );
    return rows[0];
  }

  async getOpenTransactions(companyId: number): Promise<ForexTransaction[]> {
    const { rows } = await this.client.query<ForexTransaction>(
      `SELECT * FROM forex_transactions
       WHERE company_id = $1 AND status IN ('OPEN', 'PARTIALLY_SETTLED')
         AND outstanding_fc > 0
       ORDER BY currency_code, transaction_date`,
      [companyId]
    );
    return rows;
  }

  async settle(
    fxTxnId: number,
    settlementDate: string,
    settlementRate: number
  ): Promise<ForexTransaction> {
    const { rows } = await this.client.query<ForexTransaction>(
      `SELECT * FROM forex_transactions WHERE fx_txn_id = $1`,
      [fxTxnId]
    );

    const txn = rows[0];
    if (!txn) throw new Error(`Forex transaction ${fxTxnId} not found`);

    const realizedGl = parseFloat(
      ((settlementRate - txn.transaction_rate) * txn.outstanding_fc).toFixed(2)
    );

    const { rows: updated } = await this.client.query<ForexTransaction>(
      `UPDATE forex_transactions
       SET settlement_date = $2::DATE,
           settlement_rate = $3,
           realized_gain_loss = $4,
           outstanding_fc = 0,
           status = 'SETTLED',
           updated_at = now()
       WHERE fx_txn_id = $1
       RETURNING *`,
      [fxTxnId, settlementDate, settlementRate, realizedGl]
    );
    return updated[0];
  }

  // -------------------------------------------------------------------
  // REVALUATION HISTORY
  // -------------------------------------------------------------------

  async getRevaluationRuns(companyId: number): Promise<ForexRevaluationRun[]> {
    const { rows } = await this.client.query<ForexRevaluationRun>(
      `SELECT * FROM forex_revaluation_runs
       WHERE company_id = $1
       ORDER BY reval_date DESC`,
      [companyId]
    );
    return rows;
  }

  /**
   * Forex Exposure Summary — for the CFO / dashboard
   */
  async getExposureSummary(companyId: number): Promise<{
    total_receivable_inr: number;
    total_payable_inr:   number;
    net_exposure:        number;
    currency_breakdown:  { currency: string; receivable: number; payable: number; net: number }[];
  }> {
    const { rows } = await this.client.query<{
      currency_code: string;
      receivable_inr: string;
      payable_inr: string;
    }>(
      `SELECT
         currency_code,
         COALESCE(SUM(inr_equivalent) FILTER (WHERE exposure_type IN ('RECEIVABLE','LOAN_GIVEN')), 0) AS receivable_inr,
         COALESCE(SUM(inr_equivalent) FILTER (WHERE exposure_type IN ('PAYABLE','LOAN_TAKEN')), 0) AS payable_inr
       FROM forex_transactions
       WHERE company_id = $1
         AND status IN ('OPEN', 'PARTIALLY_SETTLED')
       GROUP BY currency_code`,
      [companyId]
    );

    const breakdown = rows.map((r) => ({
      currency: r.currency_code,
      receivable: Number(r.receivable_inr),
      payable: Number(r.payable_inr),
      net: Number(r.receivable_inr) - Number(r.payable_inr),
    }));

    return {
      total_receivable_inr: breakdown.reduce((s, b) => s + b.receivable, 0),
      total_payable_inr: breakdown.reduce((s, b) => s + b.payable, 0),
      net_exposure: breakdown.reduce((s, b) => s + b.net, 0),
      currency_breakdown: breakdown,
    };
  }
}

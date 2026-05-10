// ============================================================================
// YEAR-END CLOSING SERVICE — Auto-close Revenue/Expense → Retained Earnings
// ============================================================================
// Logic: Calls the PostgreSQL stored procedure `post_year_end_closing()`
// which handles the full year-end rollover workflow.
//
// The stored procedure:
//   1. Computes total Revenue for the FY
//   2. Computes total Expenses for the FY
//   3. Posts closing JE: Debit Revenue, Credit Expenses → Retained Earnings
//   4. Locks the fiscal period (no more entries in that FY)
//   5. Records the closing in year_end_closings table
// ============================================================================

import { PoolClient } from "pg";
import { YearEndClosing, YearEndSummary } from "./closing-types.js";
import { getFinancialYear } from "@services";

export class YearEndClosingService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Execute year-end closing for the given financial year.
   * This creates a single journal entry that:
   *   - Debits all Revenue accounts (zeroing them out)
   *   - Credits all Expense accounts (zeroing them out)
   *   - Balancing entry to Retained Earnings (Profit = Credit, Loss = Debit)
   *
   * After this, the financial year is LOCKED via fiscal_periods table.
   * No further journal entries can be posted for that FY range.
   *
   * @param companyId      — Tenant company
   * @param financialYear  — Starting year (e.g., 2025 for FY 2025-2026)
   * @param executedBy     — User ID (0 = SYSTEM for automated midnight cron)
   */
  async executeYearEndClosing(
    companyId: number,
    financialYear: number,
    executedBy: number = 0
  ): Promise<YearEndClosing> {
    // Pre-flight: verify Retained Earnings account exists
    const { rows: reCheck } = await this.client.query<{ account_id: number; account_name: string }>(
      `SELECT account_id, account_name FROM accounts
       WHERE is_active = TRUE
         AND account_name ILIKE '%retained earnings%'
         AND account_type = 'Equity'
       LIMIT 1`
    );

    if (reCheck.length === 0) {
      throw new Error(
        "Retained Earnings account not found in Chart of Accounts. " +
        "Create an Equity account named 'Retained Earnings' before closing the year."
      );
    }

    // Pre-flight: check if already closed
    const alreadyClosed = await this.isYearClosed(companyId, financialYear);
    if (alreadyClosed) {
      throw new Error(`Financial year ${financialYear}-${financialYear + 1} is already closed.`);
    }

    // Execute the stored procedure
    const { rows } = await this.client.query<{ closing_id: number }>(
      `SELECT post_year_end_closing($1, $2, $3) AS closing_id`,
      [companyId, financialYear, executedBy]
    );

    // Fetch the full closing record
    return this.getClosing(rows[0].closing_id) as Promise<YearEndClosing>;
  }

  /**
   * Dry-run: preview what the year-end closing journal entry would look like
   * WITHOUT actually posting it or locking the period.
   */
  async previewYearEndClosing(
    companyId: number,
    financialYear: number
  ): Promise<{
    total_revenue: number;
    total_expenses: number;
    net_profit_loss: number;
    revenue_accounts: { account_id: number; account_name: string; balance: number }[];
    expense_accounts: { account_id: number; account_name: string; balance: number }[];
    retained_earnings_account_id: number;
    retained_earnings_impact: number;
    je_line_count: number;
  }> {
    const fyStart = `${financialYear}-04-01`;
    const fyEnd = `${financialYear + 1}-03-31`;

    const { rows: reRow } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM accounts
       WHERE is_active = TRUE
         AND account_name ILIKE '%retained earnings%'
         AND account_type = 'Equity'
       LIMIT 1`
    );

    if (reRow.length === 0) {
      throw new Error("Retained Earnings account not found.");
    }

    const revenueAccounts = await this.getAccountBalances(companyId, "Income", fyStart, fyEnd);
    const expenseAccounts = await this.getAccountBalances(companyId, "Expense", fyStart, fyEnd);

    const totalRevenue = revenueAccounts.reduce((s, a) => s + a.balance, 0);
    const totalExpenses = expenseAccounts.reduce((s, a) => s + a.balance, 0);

    return {
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      net_profit_loss: totalRevenue - totalExpenses,
      revenue_accounts: revenueAccounts,
      expense_accounts: expenseAccounts,
      retained_earnings_account_id: reRow[0].account_id,
      retained_earnings_impact: totalRevenue - totalExpenses,
      je_line_count: revenueAccounts.length + expenseAccounts.length + 1,
    };
  }

  // -------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------

  async getClosing(closingId: number): Promise<YearEndClosing | null> {
    const { rows } = await this.client.query<YearEndClosing>(
      `SELECT * FROM year_end_closings WHERE closing_id = $1`,
      [closingId]
    );
    return rows[0] ?? null;
  }

  async getClosings(companyId: number): Promise<YearEndClosing[]> {
    const { rows } = await this.client.query<YearEndClosing>(
      `SELECT * FROM year_end_closings WHERE company_id = $1 ORDER BY financial_year DESC`,
      [companyId]
    );
    return rows;
  }

  async isYearClosed(companyId: number, financialYear: number): Promise<boolean> {
    const fyStart = `${financialYear}-04-01`;
    const fyEnd = `${financialYear + 1}-03-31`;

    const { rows } = await this.client.query<{ is_locked: boolean }>(
      `SELECT is_locked FROM fiscal_periods
       WHERE company_id = $1 AND start_date = $2::DATE AND end_date = $3::DATE`,
      [companyId, fyStart, fyEnd]
    );

    return rows.length > 0 && rows[0].is_locked;
  }

  /**
   * Re-opens a closed year (ADMIN only, requires audit trail).
   * WARNING: This invalidates the closing entry. Use with extreme caution.
   */
  async reopenYear(companyId: number, financialYear: number, userId: number): Promise<void> {
    const closing = await this.getClosingForYear(companyId, financialYear);
    if (!closing) throw new Error("No closing record found for this financial year.");

    await this.client.query(
      `UPDATE fiscal_periods
       SET is_locked = FALSE, locked_by = NULL, locked_at = NULL
       WHERE company_id = $1
         AND start_date = $2::DATE
         AND end_date = $3::DATE`,
      [companyId, `${financialYear}-04-01`, `${financialYear + 1}-03-31`]
    );

    await this.client.query(
      `UPDATE year_end_closings
       SET year_locked = FALSE, notes = notes || ' | REOPENED by user ' || $3::TEXT
       WHERE company_id = $1 AND financial_year = $2`,
      [companyId, financialYear, userId]
    );
  }

  /**
   * Year-end summary for dashboard: quick view of all past closings.
   */
  async getYearEndSummaries(companyId: number): Promise<YearEndSummary[]> {
    const closings = await this.getClosings(companyId);
    const currentFy = getFinancialYear();

    const summaries: YearEndSummary[] = [];
    for (let fy = currentFy - 3; fy <= currentFy; fy++) {
      const closing = closings.find((c) => c.financial_year === fy);
      summaries.push({
        financial_year: fy,
        total_revenue: closing?.total_revenue ?? 0,
        total_expenses: closing?.total_expenses ?? 0,
        net_profit_loss: closing?.net_profit_loss ?? 0,
        profit_or_loss: !closing ? "BREAK_EVEN"
          : closing.net_profit_loss > 0 ? "PROFIT" : "LOSS",
        closed: !!closing,
        closing_date: closing?.closing_date ?? null,
      });
    }

    return summaries;
  }

  // -------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------

  private async getClosingForYear(
    companyId: number,
    financialYear: number
  ): Promise<YearEndClosing | null> {
    const { rows } = await this.client.query<YearEndClosing>(
      `SELECT * FROM year_end_closings
       WHERE company_id = $1 AND financial_year = $2`,
      [companyId, financialYear]
    );
    return rows[0] ?? null;
  }

  private async getAccountBalances(
    companyId: number,
    accountType: string,
    fyStart: string,
    fyEnd: string
  ): Promise<{ account_id: number; account_name: string; balance: number }[]> {
    const { rows } = await this.client.query<{
      account_id: number;
      account_name: string;
      balance: string;
    }>(
      `SELECT
         a.account_id,
         a.account_name,
         COALESCE(SUM(je.debit_amount), 0) - COALESCE(SUM(je.credit_amount), 0) AS balance
       FROM accounts a
       JOIN journal_entries je ON je.account_id = a.account_id
       JOIN transactions t    ON t.transaction_id = je.transaction_id
       WHERE a.is_active = TRUE
         AND a.account_type = $2
         AND t.txn_date BETWEEN $3::DATE AND $4::DATE
       GROUP BY a.account_id, a.account_name
       HAVING COALESCE(SUM(je.debit_amount), 0) - COALESCE(SUM(je.credit_amount), 0) <> 0
       ORDER BY a.account_code`,
      [companyId, accountType, fyStart, fyEnd]
    );

    return rows.map((r) => ({
      account_id: r.account_id,
      account_name: r.account_name,
      balance: Math.abs(Number(r.balance)), // Revenue: credit>debit = positive balance
    }));
  }
}

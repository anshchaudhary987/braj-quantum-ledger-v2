import { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// BALANCE SERVICE — fast balance reads (single-row lookups)
// ---------------------------------------------------------------------------

export interface AccountBalance {
  account_id: number;
  financial_year: number;
  total_debits: number;
  total_credits: number;
  closing_balance: number;
  last_updated_at: string;
  version: number;
}

export interface HierarchicalBalanceRow {
  account_id: number;
  account_name: string;
  account_type: string;
  path: string;
  nlevel: number;
  closing_balance: number;
}

export class BalanceService {
  constructor(private readonly client: PoolClient) {}

  /**
   * O(1) read — the entire purpose of the materialised account_balances table.
   * Returns the real-time closing balance for a single account in a given FY.
   */
  async getBalance(
    accountId: number,
    financialYear: number
  ): Promise<AccountBalance | null> {
    const { rows } = await this.client.query<AccountBalance>(
      `SELECT account_id, financial_year, total_debits, total_credits,
              closing_balance, last_updated_at, version
       FROM account_balances
       WHERE account_id    = $1
         AND financial_year = $2`,
      [accountId, financialYear]
    );
    return rows[0] ?? null;
  }

  /**
   * As-of-date balance — computed on the fly from journal_entries.
   * Uses the covering index idx_je_account_created_cover for an index-only scan.
   *
   *   SELECT SUM(debit_amount), SUM(credit_amount)
   *   FROM journal_entries
   *   WHERE account_id = $1 AND created_at <= $2
   */
  async getBalanceAsOf(
    accountId: number,
    asOfDate: string
  ): Promise<{ total_debit: number; total_credit: number; balance: number }> {
    const { rows } = await this.client.query<{
      total_debit: string;
      total_credit: string;
    }>(
      `SELECT COALESCE(SUM(debit_amount), 0)  AS total_debit,
              COALESCE(SUM(credit_amount), 0) AS total_credit
       FROM journal_entries
       WHERE account_id = $1 AND created_at <= $2::timestamptz`,
      [accountId, asOfDate]
    );

    const debit  = Number(rows[0].total_debit);
    const credit = Number(rows[0].total_credit);
    return { total_debit: debit, total_credit: credit, balance: debit - credit };
  }

  /**
   * Returns all leaf-level account balances for a given FY.
   * Used as the base dataset for trial-balance roll-ups.
   */
  async getAllBalances(
    financialYear: number
  ): Promise<AccountBalance[]> {
    const { rows } = await this.client.query<AccountBalance>(
      `SELECT ab.*
       FROM account_balances ab
       JOIN accounts a ON a.account_id = ab.account_id
       WHERE ab.financial_year = $1
         AND a.is_active = TRUE
       ORDER BY a.account_code`,
      [financialYear]
    );
    return rows;
  }

  /**
   * HIERARCHICAL DRILL-DOWN — computes the balance of a parent group
   * by summing all descendant accounts using ltree's <@ operator.
   *
   * Example: parent_account_id = 2 (Current Assets) →
   *   sums balances of all accounts whose path starts with '1.2'
   *
   * Path: '1.2.3' <@ '1.2' is TRUE  →  child account included
   * Path: '5.6'   <@ '1.2' is FALSE →  excluded
   */
  async getHierarchicalBalances(
    parentAccountId: number,
    financialYear: number
  ): Promise<HierarchicalBalanceRow[]> {
    const { rows } = await this.client.query<HierarchicalBalanceRow>(
      `SELECT
          child.account_id,
          child.account_name,
          child.account_type,
          child.path::TEXT AS path,
          nlevel(child.path) AS nlevel,
          COALESCE(ab.closing_balance, 0) AS closing_balance
       FROM accounts parent
       JOIN accounts child
         ON child.path <@ (parent.path::TEXT || '.*')::lquery
       LEFT JOIN account_balances ab
         ON ab.account_id   = child.account_id
        AND ab.financial_year = $2
       WHERE parent.account_id = $1
         AND child.is_active = TRUE
       ORDER BY child.path`,
      [parentAccountId, financialYear]
    );
    return rows;
  }
}
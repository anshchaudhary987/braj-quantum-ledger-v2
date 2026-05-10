import { PoolClient } from "pg";
import {
  CreateBudgetInput,
  BudgetRow,
  BudgetPeriodRow,
  BudgetVarianceRow,
} from "./budget-types";
import { AppError } from "../api/auth/auth-service";
import { ErrorCode } from "../api/errors";

// ---------------------------------------------------------------------------
// BUDGET SERVICE — CRUD + Actual vs Budget variance
// ---------------------------------------------------------------------------

export class BudgetService {
  constructor(private readonly client: PoolClient) {}

  async createBudget(input: CreateBudgetInput, companyId: number): Promise<number> {
    // Validate type-specific fields
    if (input.budget_type === "LEDGER" && !input.ledger_account_id) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "ledger_account_id is required for LEDGER budget.");
    }
    if (input.budget_type === "COST_CENTER" && !input.cost_center_id) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "cost_center_id is required for COST_CENTER budget.");
    }

    const { rows } = await this.client.query<BudgetRow>(
      `INSERT INTO budgets
         (company_id, budget_name, financial_year, budget_type,
          ledger_account_id, cost_center_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING budget_id`,
      [companyId, input.budget_name, input.financial_year, input.budget_type,
       input.ledger_account_id ?? null, input.cost_center_id ?? null]
    );

    const budgetId = rows[0].budget_id;

    // Insert periods
    for (const p of input.periods) {
      await this.client.query(
        `INSERT INTO budget_periods (budget_id, period_label, period_start, period_end, budget_amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [budgetId, p.period_label, p.period_start, p.period_end, p.budget_amount]
      );
    }

    return budgetId;
  }

  /**
   * Get Budget vs Actual variance.
   * Uses the SQL function get_budget_variance() which computes actuals
   * from journal_entries (ledger budget) or cost_center_allocations (CC budget).
   */
  async getVariance(
    budgetId: number,
    asOfDate?: string
  ): Promise<{
    budget_name: string;
    budget_type: string;
    financial_year: number;
    rows: BudgetVarianceRow[];
    totals: {
      total_budget: number;
      total_actual: number;
      total_variance: number;
    };
  }> {
    const { rows: budgetRows } = await this.client.query<BudgetRow>(
      `SELECT * FROM budgets WHERE budget_id = $1`,
      [budgetId]
    );

    if (budgetRows.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, "Budget not found.");
    }

    const { rows } = await this.client.query<BudgetVarianceRow & {
      // SQL returns NUMERIC as string from function
      budget_amount: string;
      actual_amount: string;
      variance: string;
      variance_pct: string;
      is_over_budget: boolean;
    }>(
      `SELECT * FROM get_budget_variance($1, $2)`,
      [budgetId, asOfDate ?? new Date().toISOString().split("T")[0]]
    );

    const mapped = rows.map((r) => ({
      period_label: r.period_label,
      period_start: r.period_start,
      period_end: r.period_end,
      budget_amount: Number(r.budget_amount),
      actual_amount: Number(r.actual_amount),
      variance: Number(r.variance),
      variance_pct: Number(r.variance_pct),
      is_over_budget: r.is_over_budget,
    }));

    const totalBudget  = mapped.reduce((s, r) => s + r.budget_amount, 0);
    const totalActual  = mapped.reduce((s, r) => s + r.actual_amount, 0);

    return {
      budget_name: budgetRows[0].budget_name,
      budget_type: budgetRows[0].budget_type,
      financial_year: budgetRows[0].financial_year,
      rows: mapped,
      totals: {
        total_budget: totalBudget,
        total_actual: totalActual,
        total_variance: totalBudget - totalActual,
      },
    };
  }

  /**
   * List all budgets for a company in a financial year.
   */
  async listBudgets(companyId: number, financialYear?: number): Promise<BudgetRow[]> {
    const { rows } = await this.client.query<BudgetRow>(
      `SELECT * FROM budgets
       WHERE company_id = $1
         AND (financial_year = $2 OR $2 IS NULL)
         AND is_active = TRUE
       ORDER BY budget_name`,
      [companyId, financialYear ?? null]
    );
    return rows;
  }

  /**
   * Get period-level detail with actual amount for a single budget.
   */
  async getBudgetDetail(budgetId: number): Promise<{
    budget: BudgetRow;
    periods: BudgetPeriodRow[];
  }> {
    const { rows: budgetRows } = await this.client.query<BudgetRow>(
      `SELECT * FROM budgets WHERE budget_id = $1`, [budgetId]
    );
    if (budgetRows.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, "Budget not found.");
    }

    const { rows: periodRows } = await this.client.query<BudgetPeriodRow>(
      `SELECT * FROM budget_periods WHERE budget_id = $1 ORDER BY period_start`,
      [budgetId]
    );

    return { budget: budgetRows[0], periods: periodRows };
  }
}
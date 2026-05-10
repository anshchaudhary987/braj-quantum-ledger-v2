// ============================================================================
// YEAR-END CLOSING TYPE DEFINITIONS
// ============================================================================

export interface YearEndClosing {
  closing_id: number;
  company_id: number;
  financial_year: number;
  closing_date: string;
  executed_at: string;
  transaction_id: number | null;
  total_revenue: number;
  total_expenses: number;
  net_profit_loss: number;
  retained_earnings_account_id: number;
  year_locked: boolean;
  locked_at: string | null;
  executed_by: number;
  notes: string | null;
}

export interface YearEndSummary {
  financial_year: number;
  total_revenue: number;
  total_expenses: number;
  net_profit_loss: number;
  profit_or_loss: "PROFIT" | "LOSS" | "BREAK_EVEN";
  closed: boolean;
  closing_date: string | null;
}
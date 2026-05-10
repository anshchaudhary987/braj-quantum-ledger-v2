// ============================================================================
// FOREX TYPE DEFINITIONS
// ============================================================================

export interface ForexTransaction {
  fx_txn_id: number;
  company_id: number;
  transaction_id: number;
  exposure_type: "RECEIVABLE" | "PAYABLE" | "LOAN_GIVEN" | "LOAN_TAKEN";
  currency_code: string;
  fc_amount: number;
  transaction_rate: number;
  inr_equivalent: number;
  counterparty_account_id: number;
  counterparty_name: string;
  transaction_date: string;
  due_date: string | null;
  settlement_date: string | null;
  settlement_rate: number | null;
  realized_gain_loss: number | null;
  last_reval_date: string | null;
  last_reval_rate: number | null;
  unrealized_gain_loss: number;
  status: "OPEN" | "PARTIALLY_SETTLED" | "SETTLED" | "WRITTEN_OFF";
  outstanding_fc: number;
}

export interface ExchangeRate {
  rate_id: number;
  currency_code: string;
  rate_date: string;
  rate_to_inr: number;
  source: string;
}

export interface ForexRevaluationRun {
  reval_run_id: number;
  company_id: number;
  reval_date: string;
  transaction_id: number | null;
  total_gain: number;
  total_loss: number;
  net_gl: number;
  fx_txn_count: number;
  status: string;
}

export interface RegisterForexInput {
  company_id: number;
  transaction_id: number;
  exposure_type: "RECEIVABLE" | "PAYABLE" | "LOAN_GIVEN" | "LOAN_TAKEN";
  currency_code: string;
  fc_amount: number;
  transaction_rate: number;
  counterparty_account_id: number;
  counterparty_name?: string;
  transaction_date: string;
  due_date?: string;
}

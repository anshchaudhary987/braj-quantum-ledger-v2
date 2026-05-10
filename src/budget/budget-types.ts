export type BudgetType = "LEDGER" | "COST_CENTER";

export type InterestType = "SIMPLE" | "COMPOUND";

export type InterestStyle = "30_DAY_MONTH" | "365_DAY_YEAR" | "ACTUAL_DAYS";

export type CompoundFrequency = "YEARLY" | "QUARTERLY" | "MONTHLY" | "DAILY";

// ---------- Budget ----------

export interface BudgetRow {
  budget_id: number;
  company_id: number;
  budget_name: string;
  financial_year: number;
  budget_type: BudgetType;
  ledger_account_id: number | null;
  cost_center_id: number | null;
  is_active: boolean;
}

export interface BudgetPeriodRow {
  period_id: number;
  budget_id: number;
  period_label: string;
  period_start: string;
  period_end: string;
  budget_amount: string;
}

export interface BudgetVarianceRow {
  period_label: string;
  period_start: string;
  period_end: string;
  budget_amount: number;
  actual_amount: number;
  variance: number;           // positive = under budget, negative = over
  variance_pct: number;
  is_over_budget: boolean;
}

// ---------- Interest ----------

export interface InterestConfigRow {
  config_id: number;
  company_id: number;
  config_name: string;
  interest_type: InterestType;
  rate_per_annum: string;
  compounding_frequency: CompoundFrequency;
  interest_style: InterestStyle;
  grace_period_days: number;
  ledger_account_id: number | null;
  is_active: boolean;
}

export interface InterestProvisionRow {
  provision_id: number;
  company_id: number;
  config_id: number;
  bill_ref_id: number;
  provision_date: string;
  principal_amount: string;
  interest_rate: string;
  days_overdue: number;
  calculated_interest: string;
  is_posted: boolean;
  posted_transaction_id: number | null;
  posted_at: string | null;
}

// ---------- Scenario ----------

export interface ScenarioRow {
  scenario_id: number;
  company_id: number;
  scenario_name: string;
  description: string | null;
  is_active: boolean;
}

export interface ScenarioVoucherRow {
  scenario_voucher_id: number;
  scenario_id: number;
  company_id: number;
  voucher_date: string;
  description: string | null;
  voucher_type: string;
  metadata: Record<string, unknown>;
  is_promoted: boolean;
  promoted_transaction_id: number | null;
}

export interface ScenarioEntryRow {
  scenario_entry_id: number;
  scenario_voucher_id: number;
  account_id: number;
  debit_amount: string;
  credit_amount: string;
  description: string | null;
}

// ---------- API Inputs ----------

export interface CreateBudgetInput {
  budget_name: string;
  financial_year: number;
  budget_type: BudgetType;
  ledger_account_id?: number;
  cost_center_id?: number;
  periods: Array<{
    period_label: string;
    period_start: string;
    period_end: string;
    budget_amount: number;
  }>;
}

export interface ProvisionInterestInput {
  config_id: number;
  as_of_date?: string;
}

export interface PostInterestProvisionInput {
  provision_id: number;
  idempotency_key: string;
}

export interface CreateScenarioInput {
  scenario_name: string;
  description?: string;
}

export interface CreateScenarioVoucherInput {
  scenario_id: number;
  voucher_date: string;
  description?: string;
  voucher_type: string;
  entries: Array<{
    account_id: number;
    debit_amount: number;
    credit_amount: number;
    description?: string;
  }>;
}

export interface PromoteScenarioResult {
  scenario_voucher_id: number;
  transaction_id: number;
  promoted_entries: number;
}
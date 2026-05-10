// ============================================================================
// DEPRECIATION TYPE DEFINITIONS
// ============================================================================

export interface AssetBlock {
  asset_block_id: number;
  company_id: number;
  block_name: string;
  depreciation_rate: number;         // Income Tax WDV rate %
  companies_act_rate: number | null; // Companies Act SLM rate %
  useful_life_years: number | null;
  residual_value_pct: number;
}

export interface FixedAsset {
  asset_id: number;
  company_id: number;
  asset_block_id: number;
  asset_code: string;
  asset_name: string;
  serial_number: string | null;
  purchase_date: string;
  purchase_value: number;
  residual_value: number;
  depreciable_value: number;
  slm_rate: number | null;
  slm_annual_depr: number;
  accumulated_depr: number;
  wdv_as_on: number;
  status: "ACTIVE" | "SOLD" | "DISCARDED" | "IMPAIRED";
  asset_gl_account_id: number;
  accumulated_depr_gl_id: number;
  depreciation_expense_gl_id: number;
}

export interface DepreciationRun {
  depr_run_id: number;
  company_id: number;
  financial_year: number;
  run_date: string;
  act_type: "INCOME_TAX" | "COMPANIES_ACT";
  asset_count: number;
  total_depreciation: number;
  transaction_id: number | null;
  status: "DRAFT" | "COMPLETED" | "REVERSED";
}

export interface DepreciationRunItem {
  depr_run_item_id: number;
  asset_id: number;
  opening_wdv: number;
  depreciation_for_year: number;
  closing_wdv: number;
}

export interface CreateAssetInput {
  company_id: number;
  asset_block_id: number;
  asset_code: string;
  asset_name: string;
  serial_number?: string;
  purchase_date: string;
  purchase_value: number;
  residual_value?: number;
  slm_rate?: number;          // If provided, uses SLM; otherwise defaults to block's WDV rate
  asset_gl_account_id: number;
  accumulated_depr_gl_id: number;
  depreciation_expense_gl_id: number;
}
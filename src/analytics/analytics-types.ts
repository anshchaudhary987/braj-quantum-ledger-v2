// ============================================================================
// ANALYTICS TYPE DEFINITIONS — Executive Dashboard & Financial Reporting
// ============================================================================

// ---------------------------------------------------------------------------
// Cash Flow Statement
// ---------------------------------------------------------------------------

export interface CashFlowLine {
  section: "OPERATING" | "INVESTING" | "FINANCING" | "RECONCILIATION";
  line_item: string;
  amount: number;
  sort_order: number;
}

export interface CashFlowReport {
  from_date: string;
  to_date: string;
  lines: CashFlowLine[];
  operating_total: number;
  investing_total: number;
  financing_total: number;
  net_cash_change: number;
  variance: number;
}

export interface CashFlowSectionSummary {
  section: string;
  amount: number;
}

// ---------------------------------------------------------------------------
// Financial Ratios
// ---------------------------------------------------------------------------

export interface FinancialRatio {
  ratio_name: string;
  ratio_value: number | null;
  numerator: number;
  denominator: number;
  formula: string;
  health: "HEALTHY" | "RISK" | "N/A";
}

export interface RatioReport {
  as_of_date: string;
  ratios: FinancialRatio[];
}

// ---------------------------------------------------------------------------
// Inventory Aging
// ---------------------------------------------------------------------------

export interface InventoryAgingLine {
  stock_item_id: number;
  item_name: string;
  batch_number: string;
  aging_bucket: "0-30 days" | "31-60 days" | "61-90 days" | "90+ days";
  total_qty: number;
  total_value: number;
  days_old_min: number;
  days_old_max: number;
}

export interface InventoryAgingSummary {
  aging_bucket: string;
  qty_on_hand: number;
  value_at_risk: number;
  item_count: number;
}

export interface InventoryAgingReport {
  as_of_date: string;
  details: InventoryAgingLine[];
  summary: InventoryAgingSummary[];
}

// ---------------------------------------------------------------------------
// Executive Dashboard (single composite response)
// ---------------------------------------------------------------------------

export interface ExecutiveDashboard {
  as_of_date: string;
  ratios: FinancialRatio[];
  inventory_aging_summary: InventoryAgingSummary[];
  cash_flow_summary: CashFlowSectionSummary[];
  key_metrics: DashboardKeyMetrics;
}

export interface DashboardKeyMetrics {
  revenue: number;
  net_income: number;
  current_ratio: number | null;
  debt_to_equity: number | null;
  net_profit_margin: number | null;
  cash_balance: number;
  inventory_value: number;
  receivables_ageing: { bucket: string; amount: number }[];
}

// ---------------------------------------------------------------------------
// Cache Control Types
// ---------------------------------------------------------------------------

export type ReportType =
  | "cash_flow"
  | "ratios"
  | "inventory_aging"
  | "inventory_aging_summary"
  | "executive_dashboard";

export interface CacheConfig {
  ttl: number;                          // seconds
  staleWhileRevalidate: boolean;
  refreshThreshold: number;             // fraction of TTL (0-1)
}

export interface CacheEnvelope<T> {
  data: T;
  expiresAt: number;                    // epoch ms
  computedAt: number;                   // epoch ms
}

export interface CacheState {
  cache_key: string;
  tenant_id: string;
  report_type: ReportType;
  last_refreshed: string;
  next_scheduled: string | null;
  row_count: number | null;
  compute_time_ms: number | null;
}

// ---------------------------------------------------------------------------
// Invalidation Events
// ---------------------------------------------------------------------------

export enum AnalyticsEventType {
  JOURNAL_POSTED       = "journal:posted",
  JOURNAL_VOIDED       = "journal:voided",
  STOCK_MOVEMENT       = "stock:moved",
  BANK_RECONCILIATION  = "bank:reconciled",
  PERIOD_CLOSED        = "period:closed",
}

export interface InvalidationPayload {
  tenant_id: string;
  journal_entry?: {
    account_ids: number[];
    transaction_date: string;
  };
  stock_item_ids?: number[];
}

// ---------------------------------------------------------------------------
// Account Classification (for auto-segregation)
// ---------------------------------------------------------------------------

export interface AccountClassification {
  account_id: number;
  account_name: string;
  account_type: string;
  cash_flow_section: "OPERATING" | "INVESTING" | "FINANCING" | null;
  account_sub_type: string | null;
  is_cash_account: boolean;
}

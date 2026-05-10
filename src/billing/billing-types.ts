export type ReferenceType = "NEW_REF" | "AGST_REF" | "ADVANCE" | "ON_ACCOUNT";

export type BillStatus =
  | "PENDING"
  | "PARTIALLY_PAID"
  | "SETTLED"
  | "CANCELLED"
  | "ADVANCE_PENDING"
  | "ADVANCE_CONSUMED";

export type AgingBucket = "NOT_DUE" | "0_30_DAYS" | "31_60_DAYS" | "61_90_DAYS" | "91_180_DAYS" | "OVER_180_DAYS";

// ---------- Database row types ----------

export interface BillReferenceRow {
  bill_ref_id: number;
  company_id: number;
  transaction_id: number;
  journal_entry_id: number;
  ledger_account_id: number;
  reference_type: ReferenceType;
  bill_number: string | null;
  bill_date: string | null;
  due_date: string | null;
  bill_description: string | null;
  original_amount: string;
  pending_amount: string;
  settled_amount: string;
  adjusted_against_bill_ref_id: number | null;
  adjustment_amount: string | null;
  is_advance_available: boolean;
  status: BillStatus;
}

export interface PendingBillView {
  bill_ref_id: number;
  bill_number: string | null;
  bill_date: string | null;
  due_date: string | null;
  bill_description: string | null;
  party_name: string;
  party_code: string;
  original_amount: number;
  pending_amount: number;
  settled_amount: number;
  status: BillStatus;
  days_overdue: number;
  aging_bucket: AgingBucket;
}

export interface AgingReportRow {
  party_name: string;
  party_code: string;
  total_outstanding: number;
  not_due: number;
  days_0_30: number;
  days_31_60: number;
  days_61_90: number;
  days_91_180: number;
  days_over_180: number;
}

// ---------- Input / Result types ----------

export interface CreateBillInput {
  ledger_account_id: number;
  bill_number: string;
  bill_date: string;
  bill_description?: string;
  original_amount: number;
  transaction_id: number;
  journal_entry_id: number;
  idempotency_key: string;
}

export interface CreateBillResult {
  bill_ref_id: number;
  bill_number: string;
  due_date: string;
  credit_warning?: string;
}

export interface AdjustBillInput {
  /** The bill_ref_id of the original NEW_REF bill being paid. */
  bill_ref_id: number;
  ledger_account_id: number;
  adjustment_amount: number;
  transaction_id: number;
  journal_entry_id: number;
  idempotency_key: string;
}

export interface AdjustBillResult {
  bill_ref_id: number;
  bill_number: string;
  previous_pending: number;
  adjustment_amount: number;
  new_pending: number;
  is_settled: boolean;
}

export interface CreateAdvanceInput {
  ledger_account_id: number;
  advance_amount: number;
  advance_date: string;
  description?: string;
  transaction_id: number;
  journal_entry_id: number;
  idempotency_key: string;
}

export interface CreateAdvanceResult {
  bill_ref_id: number;
  advance_amount: number;
  is_available: boolean;
}

export interface PendingBillsQuery {
  ledger_account_id: number;
  company_id: number;
  include_advances?: boolean;  // also show available advances
}

export interface CreditValidationResult {
  is_valid: boolean;
  current_exposure: number;
  credit_limit: number;
  warning_message: string | null;
}
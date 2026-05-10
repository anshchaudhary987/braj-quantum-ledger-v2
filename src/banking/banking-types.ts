export interface BankAccountRow {
  bank_account_id: number;
  company_id: number;
  account_id: number;
  bank_name: string;
  branch_name: string | null;
  ifsc_code: string;
  account_number_masked: string;
  account_type: "SAVINGS" | "CURRENT" | "OVERDRAFT" | "CASH_CREDIT" | "OD";
  aa_fip_id: string | null;
  is_aa_enabled: boolean;
  aa_last_synced_at: string | null;
  opening_balance: string | null;
  opening_balance_date: string | null;
}

export interface BankStatementRow {
  bank_statement_id: number;
  company_id: number;
  bank_account_id: number;
  transaction_date: string;
  value_date: string | null;
  description: string;
  transaction_ref: string | null;
  transaction_type: string | null;
  debit_amount: string;
  credit_amount: string;
  running_balance: string | null;
  source: "IMPORT" | "AA_FETCH" | "MANUAL";
  reconciliation_status: ReconciliationStatus;
  matched_journal_entry_id: number | null;
  matched_transaction_id: number | null;
  match_confidence: string | null;
  match_rule: string | null;
  reconciled_by: number | null;
  reconciled_at: string | null;
  reconciliation_notes: string | null;
  raw_data: Record<string, unknown> | null;
}

export type ReconciliationStatus =
  | "PENDING"
  | "MATCHED"
  | "SUGGESTED"
  | "UNRECONCILED"
  | "PARTIALLY_MATCHED"
  | "IGNORED"
  | "DUPLICATE";

export interface ReconciliationRuleRow {
  rule_id: number;
  company_id: number;
  rule_name: string;
  amount_match_weight: number;
  date_proximity_weight: number;
  reference_match_weight: number;
  description_match_weight: number;
  date_proximity_days: number;
  auto_match_threshold: number;
  suggest_match_threshold: number;
}

export interface AaConsentRow {
  consent_id: string;
  company_id: number;
  bank_account_id: number;
  consent_handle: string;
  consent_status: "ACTIVE" | "EXPIRED" | "REVOKED" | "PAUSED";
  fi_data_range_from: string;
  fi_data_range_to: string;
  fip_id: string;
  last_fetch_at: string | null;
}

// ---------- Service types ----------

export interface BankStatementImportInput {
  bank_account_id: number;
  file_buffer: Buffer;
  file_name: string;
  file_format: "CSV" | "XLSX" | "PDF";       // PDF = statement PDF parsing
}

export interface BankStatementImportResult {
  batch_id: string;
  total_rows: number;
  rows_imported: number;
  rows_skipped: number;                     // duplicates
  rows_auto_matched: number;
  rows_suggested: number;
  rows_unreconciled: number;
}

export interface MatchCandidate {
  bank_statement_id: number;
  journal_entry_id?: number;
  transaction_id?: number;
  confidence: number;
  match_rule: string;
  description: string;
  amount: number;
  bank_date: string;
  journal_date?: string;
}

export interface AutoMatchResult {
  bank_statement_id: number;
  status: ReconciliationStatus;
  matched_entry_id?: number;
  matched_transaction_id?: number;
  confidence: number;
  match_rule: string;
}

export interface UnreconciledEntryView {
  bank_statement_id: number;
  bank_name: string;
  account_number_masked: string;
  transaction_date: string;
  description: string;
  transaction_ref: string | null;
  transaction_type: string | null;
  debit_amount: number;
  credit_amount: number;
  running_balance: number | null;
  status: ReconciliationStatus;
  match_candidates?: MatchCandidate[];
}

export interface CreateVoucherFromBankEntryInput {
  bank_statement_id: number;
  voucher_type: "PAYMENT_VOUCHER" | "RECEIPT_VOUCHER";
  ledger_account_id: number;               // counter-party: Vendor (payment) or Customer/Payer (receipt)
  narration?: string;
  idempotency_key: string;
}

export interface AaFetchResult {
  consent_id: string;
  bank_account_id: number;
  transactions_fetched: number;
  date_range: { from: string; to: string };
  is_success: boolean;
  error_message?: string;
}

export interface TdsSectionRow {
  section_id: number;
  section_code: string;
  section_name: string;
  applicable_on: "PURCHASE" | "PAYMENT" | "BOTH";
  single_bill_threshold: string | null;
  aggregate_yearly_threshold: string | null;
  default_tds_rate: string;
  surcharge_rate: string;
  health_education_cess: string;
  effective_from: string;
  effective_to: string | null;
}

export interface TdsSectionRateRow {
  rate_id: number;
  section_id: number;
  deductee_type: "INDIVIDUAL_HUF" | "COMPANY" | "OTHERS" | "NON_RESIDENT" | "NO_PAN";
  tds_rate: string;
}

export interface TdsPanDetailRow {
  pan_detail_id: number;
  company_id: number;
  account_id: number;
  pan_number: string | null;
  pan_status: "VERIFIED" | "INVALID" | "NOT_AVAILABLE" | "APPLIED" | "EXEMPT";
  deductee_type: string;
  name_on_pan: string | null;
}

export interface TdsLowerCertRow {
  cert_id: number;
  account_id: number;
  section_id: number;
  certificate_number: string;
  valid_from: string;
  valid_to: string;
  lower_tds_rate: string | null;
  is_nil_deduction: boolean;
}

export interface TdsThresholdTrackerRow {
  tracker_id: number;
  company_id: number;
  section_id: number;
  vendor_account_id: number;
  financial_year: number;
  cumulative_taxable_amount: string;
  cumulative_tds_deducted: string;
}

export interface TdsEntryRow {
  tds_entry_id: number;
  transaction_id: number;
  journal_entry_id: number;
  section_id: number;
  vendor_account_id: number;
  gross_amount: string;
  taxable_amount: string;
  tds_rate: string;
  tds_amount: string;
  surcharge_amount: string;
  cess_amount: string;
  total_tds: string;
  deductee_pan: string | null;
  deductee_pan_status: string | null;
  rate_source: "SECTION_DEFAULT" | "NO_PAN_20_PCT" | "LOWER_DEDUCTION_CERT" | "NIL_DEDUCTION";
  lower_deduction_cert_id: number | null;
  return_period: string | null;
}

export interface TcsEntryRow {
  tcs_entry_id: number;
  transaction_id: number;
  buyer_account_id: number;
  cumulative_receipts_before: string;
  amount_exceeding_50l: string | null;
  tcs_rate: string;
  tcs_amount: string;
  buyer_pan: string | null;
  return_period: string | null;
}

export interface TaxPaymentRow {
  payment_id: number;
  challan_serial_number: string;
  bsr_code: string;
  challan_date: string;
  section_code: string;
  assessment_year: string;
  total_tds_amount: string;
  interest_amount: string;
  late_fee_amount: string;
  total_paid: string;
  payment_mode: string;
  bank_name: string | null;
}

// ---------- API Inputs ----------

export interface TdsDeductionInput {
  section_code: string;          // e.g., '194C'
  vendor_account_id: number;
  gross_amount: number;          // total invoice amount
  taxable_amount: number;        // amount on which TDS is computed (usually = gross)
  transaction_id: number;        // the purchase voucher txn ID
  journal_entry_ids: {          // the journal lines to auto-inject TDS into
    expense_line_id: number;     // Debit: Expense
    vendor_line_id: number;      // Credit: Vendor (this will be split into vendor net + TDS payable)
  };
  voucher_date: string;
  idempotency_key: string;
}

export interface TdsDeductionResult {
  tds_applicable: boolean;
  tds_entry_id?: number;
  section_code: string;
  tds_rate: number;
  tds_amount: number;
  total_tds: number;
  rate_source: string;
  threshold_crossed: boolean;
  reason_if_skipped?: string;
}

export interface TcsCalculationInput {
  buyer_account_id: number;
  invoice_amount: number;
  transaction_id: number;
  voucher_date: string;
  idempotency_key: string;
}

export interface TcsCalculationResult {
  tcs_applicable: boolean;
  tcs_amount: number;
  tcs_rate: number;
  cumulative_before: number;
  amount_exceeding_50l: number | null;
  reason_if_skipped?: string;
}

export interface Form26QRow {
  pan_of_deductee: string | null;
  deductee_name: string;
  section_code: string;
  amount_paid_credited: number;
  tds_rate: number;
  total_tax_deducted: number;
  deduction_date: string;
  challan_serial_number: string | null;
  bsr_code: string | null;
  deposit_date: string | null;
  payment_status: string;
}

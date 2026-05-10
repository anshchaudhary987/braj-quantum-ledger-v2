// ============================================================================
// INDIAN PAYROLL & HRMS — TypeScript Type Definitions
// ============================================================================

// ── ENUMS ──────────────────────────────────────────────────────────────────

export type EmployeeStatus = "ACTIVE" | "INACTIVE" | "TERMINATED" | "ON_LEAVE";

export type PayrollStatus =
  | "DRAFT"
  | "COMPUTED"
  | "APPROVED"
  | "JOURNAL_POSTED"
  | "PAID"
  | "CANCELLED";

export type PayHeadType = "EARNING" | "DEDUCTION";

export type AttendanceStatus =
  | "PRESENT"
  | "ABSENT"
  | "HALF_DAY"
  | "PAID_LEAVE"
  | "UNPAID_LEAVE"
  | "WEEKLY_OFF"
  | "HOLIDAY";

export type PfApplicability = "FULL" | "RESTRICTED" | "EXCLUDED" | "EXEMPT";

export type EsiApplicability = "COVERED" | "EXCLUDED" | "EXEMPT";

// ── DATABASE ROW TYPES ─────────────────────────────────────────────────────

export interface EmployeeRow {
  employee_id: number;
  tenant_id: string;
  employee_code: string;
  first_name: string;
  last_name: string | null;
  date_of_birth: string | null;
  date_of_joining: string;
  date_of_exit: string | null;
  gender: string | null;
  pan: string | null;
  uan: string | null;
  pf_number: string | null;
  esi_ip_number: string | null;
  pran: string | null;
  work_location_state: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_name: string | null;
  employee_account_id: number | null;
  pf_applicability: PfApplicability;
  esi_applicability: EsiApplicability;
  is_eligible_for_pt: boolean;
  tax_regime: string;
  declared_investments: string;
  other_income: string;
  status: EmployeeStatus;
  metadata: Record<string, unknown>;
}

export interface SalaryStructureRow {
  structure_id: number;
  employee_id: number;
  tenant_id: string;
  component_name: string;
  component_type: PayHeadType;
  statutory_tag: string | null;
  amount_or_percent: string;
  is_percentage: boolean;
  base_wage_ref: string | null;
  is_active: boolean;
  effective_from: string;
  effective_to: string | null;
  metadata: Record<string, unknown>;
}

export interface PayPeriodRow {
  pay_period_id: number;
  tenant_id: string;
  period_name: string;
  period_start: string;
  period_end: string;
  working_days: number;
  is_closed: boolean;
  created_at: string;
}

export interface AttendanceLogRow {
  attendance_id: number;
  employee_id: number;
  pay_period_id: number;
  tenant_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  hours_worked: string | null;
  lop_days: string;
  remarks: string | null;
}

export interface PayrollRunRow {
  payroll_run_id: number;
  tenant_id: string;
  pay_period_id: number;
  run_description: string;
  run_date: string;
  payment_date: string | null;
  total_gross_salary: string;
  total_employer_pf: string;
  total_employer_esi: string;
  total_employee_pf: string;
  total_employee_esi: string;
  total_professional_tax: string;
  total_income_tax_tds: string;
  total_net_pay: string;
  transaction_id: number | null;
  status: PayrollStatus;
  status_history: StatusHistoryEntry[];
  approved_by: string | null;
  approved_at: string | null;
}

export interface PayrollRunDetailRow {
  detail_id: number;
  payroll_run_id: number;
  employee_id: number;
  tenant_id: string;
  days_present: string;
  days_absent: string;
  lop_days: string;
  days_payable: string;
  basic_wage: string;
  hra: string;
  conveyance: string;
  special_allowance: string;
  other_earnings: string;
  gross_earnings: string;
  employee_pf: string;
  employee_esi: string;
  professional_tax: string;
  income_tax_tds: string;
  other_deductions: string;
  total_deductions: string;
  employer_pf: string;
  employer_esi: string;
  net_pay: string;
  pf_wage: string;
  esi_wage: string;
  metadata: Record<string, unknown>;
}

export interface StatutoryRateRow {
  rate_id: number;
  component: string;
  sub_component: string | null;
  rate_percent: string | null;
  wage_floor: string;
  wage_ceiling: string | null;
  state_code: string | null;
  slab_from: string | null;
  slab_to: string | null;
  fixed_amount: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface StatusHistoryEntry {
  status: string;
  timestamp: string;
  actor: string;
}

// ── SALARY COMPONENT COMPUTATION ───────────────────────────────────────────

export interface SalaryComponentResult {
  component_name: string;
  component_type: PayHeadType;
  amount: number;
  statutory_tag: string | null;
}

export interface StatutoryDeductions {
  pf_wage: number;
  employee_pf: number;
  employer_pf: number;
  employer_eps: number;
  total_pf: number;
  esi_wage: number;
  employee_esi: number;
  employer_esi: number;
  total_esi: number;
  professional_tax: number;
  pt_slab: string;
  income_tax_tds: number;
  annual_tax: number;
  cess_amount: number;
  total_deductions: number;
  total_employer_contributions: number;
}

export interface EmployeePayrollResult {
  employee_id: number;
  employee_code: string;
  employee_name: string;
  days_present: number;
  days_absent: number;
  lop_days: number;
  days_payable: number;
  earnings: SalaryComponentResult[];
  basic_wage: number;
  hra: number;
  conveyance: number;
  special_allowance: number;
  other_earnings: number;
  gross_earnings: number;
  statutory: StatutoryDeductions;
  other_deductions: number;
  total_deductions: number;
  employer_pf: number;
  employer_esi: number;
  net_pay: number;
  pan: string | null;
  uan: string | null;
  esi_ip_number: string | null;
  bank_account_number: string | null;
}

export interface PayrollRunResult {
  payroll_run_id: number;
  pay_period_id: number;
  period_name: string;
  run_description: string;
  employee_count: number;
  summary: {
    total_gross_salary: number;
    total_employer_pf: number;
    total_employer_esi: number;
    total_employee_pf: number;
    total_employee_esi: number;
    total_professional_tax: number;
    total_income_tax_tds: number;
    total_net_pay: number;
  };
  details: EmployeePayrollResult[];
  journal_entry?: JournalSummary;
}

export interface JournalSummary {
  transaction_id: number | null;
  entries: Array<{
    account_id: number;
    account_name: string;
    debit: number;
    credit: number;
    description: string;
  }>;
}

// ── SERVICE INPUTS ──────────────────────────────────────────────────────────

export interface CreateEmployeeInput {
  tenant_id: string;
  employee_code: string;
  first_name: string;
  last_name?: string;
  date_of_joining: string;
  date_of_birth?: string;
  pan?: string;
  uan?: string;
  pf_number?: string;
  esi_ip_number?: string;
  work_location_state?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
  employee_account_id?: number;
  pf_applicability?: PfApplicability;
  esi_applicability?: EsiApplicability;
  tax_regime?: string;
  declared_investments?: number;
}

export interface CreateSalaryStructureInput {
  employee_id: number;
  tenant_id: string;
  components: Array<{
    component_name: string;
    component_type: PayHeadType;
    statutory_tag?: string;
    amount_or_percent: number;
    is_percentage: boolean;
    base_wage_ref?: string;
  }>;
  effective_from?: string;
}

export interface CreatePayPeriodInput {
  tenant_id: string;
  period_name: string;
  period_start: string;
  period_end: string;
  working_days: number;
}

export interface MarkAttendanceInput {
  employee_id: number;
  pay_period_id: number;
  tenant_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  hours_worked?: number;
}

export interface RunPayrollInput {
  tenant_id: string;
  pay_period_id: number;
  run_description?: string;
}

export interface ApprovePayrollInput {
  payroll_run_id: number;
  approved_by: string;
}
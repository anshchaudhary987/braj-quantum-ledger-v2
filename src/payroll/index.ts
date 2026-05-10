// ============================================================================
// PAYROLL & HRMS — Module barrel export
// ============================================================================

export { PayrollService } from "./payroll-service.js";
export { PayrollEngine } from "./payroll-engine.js";
export type {
  EmployeeStatus,
  PayrollStatus,
  PayHeadType,
  AttendanceStatus,
  PfApplicability,
  EsiApplicability,
  EmployeeRow,
  SalaryStructureRow,
  PayPeriodRow,
  AttendanceLogRow,
  PayrollRunRow,
  PayrollRunDetailRow,
  StatutoryRateRow,
  StatusHistoryEntry,
  SalaryComponentResult,
  StatutoryDeductions,
  EmployeePayrollResult,
  PayrollRunResult,
  JournalSummary,
  CreateEmployeeInput,
  CreateSalaryStructureInput,
  CreatePayPeriodInput,
  MarkAttendanceInput,
  RunPayrollInput,
  ApprovePayrollInput,
} from "./payroll-types";

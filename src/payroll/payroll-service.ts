// ============================================================================
// PAYROLL SERVICE — Run Payroll, Approve, Auto-Journal Orchestration
// ============================================================================

import { PoolClient } from "pg";
import { PayrollEngine } from "./payroll-engine.js";
import {
  EmployeeRow,
  PayPeriodRow,
  PayrollRunRow,
  PayrollRunDetailRow,
  EmployeePayrollResult,
  PayrollRunResult,
  JournalSummary,
  RunPayrollInput,
  ApprovePayrollInput,
  CreateEmployeeInput,
  CreateSalaryStructureInput,
  CreatePayPeriodInput,
  MarkAttendanceInput,
} from "./payroll-types.js";

export class PayrollService {
  constructor(private readonly client: PoolClient) {}

  // =========================================================================
  // EMPLOYEE CRUD
  // =========================================================================

  async createEmployee(input: CreateEmployeeInput): Promise<EmployeeRow> {
    const { rows } = await this.client.query<EmployeeRow>(
      `INSERT INTO employees (
         tenant_id, employee_code, first_name, last_name,
         date_of_birth, date_of_joining, pan, uan, pf_number,
         esi_ip_number, work_location_state,
         bank_account_number, bank_ifsc, bank_name,
         employee_account_id, pf_applicability, esi_applicability,
         is_eligible_for_pt, tax_regime, declared_investments, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'ACTIVE')
       RETURNING *`,
      [
        input.tenant_id, input.employee_code, input.first_name, input.last_name ?? null,
        input.date_of_birth ?? null, input.date_of_joining, input.pan ?? null,
        input.uan ?? null, input.pf_number ?? null, input.esi_ip_number ?? null,
        input.work_location_state ?? null,
        input.bank_account_number ?? null, input.bank_ifsc ?? null, null,
        input.employee_account_id ?? null,
        input.pf_applicability ?? "FULL", input.esi_applicability ?? "COVERED",
        input.pf_applicability !== "EXEMPT", input.tax_regime ?? "NEW",
        input.declared_investments ?? 0,
      ]
    );
    return rows[0];
  }

  async getEmployee(employeeId: number, tenantId: string): Promise<EmployeeRow | null> {
    const { rows } = await this.client.query<EmployeeRow>(
      `SELECT * FROM employees WHERE employee_id = $1 AND tenant_id = $2`,
      [employeeId, tenantId]
    );
    return rows[0] ?? null;
  }

  async listEmployees(tenantId: string, status?: string): Promise<EmployeeRow[]> {
    const { rows } = await this.client.query<EmployeeRow>(
      `SELECT * FROM employees WHERE tenant_id = $1
       ${status ? "AND status = $2" : ""}
       ORDER BY employee_code`,
      status ? [tenantId, status] : [tenantId]
    );
    return rows;
  }

  // =========================================================================
  // SALARY STRUCTURE
  // =========================================================================

  async setSalaryStructure(input: CreateSalaryStructureInput): Promise<number> {
    await this.assertEmployeeBelongsToTenant(input.employee_id, input.tenant_id);

    // Deactivate previous structure
    await this.client.query(
      `UPDATE salary_structures
       SET is_active = FALSE, effective_to = $2, updated_at = now()
       WHERE employee_id = $1 AND is_active = TRUE AND tenant_id = $3`,
      [input.employee_id, input.effective_from ?? new Date().toISOString().split("T")[0], input.tenant_id]
    );

    // Insert new components
    for (const comp of input.components) {
      await this.client.query(
        `INSERT INTO salary_structures (
           employee_id, tenant_id, component_name, component_type,
           statutory_tag, amount_or_percent, is_percentage, base_wage_ref,
           effective_from, is_active
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
        [
          input.employee_id, input.tenant_id,
          comp.component_name, comp.component_type,
          comp.statutory_tag ?? null, comp.amount_or_percent,
          comp.is_percentage, comp.base_wage_ref ?? null,
          input.effective_from ?? new Date().toISOString().split("T")[0],
        ]
      );
    }
    return input.components.length;
  }

  // =========================================================================
  // PAY PERIODS
  // =========================================================================

  async createPayPeriod(input: CreatePayPeriodInput): Promise<PayPeriodRow> {
    const { rows } = await this.client.query<PayPeriodRow>(
      `INSERT INTO pay_periods (tenant_id, period_name, period_start, period_end, working_days)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [input.tenant_id, input.period_name, input.period_start, input.period_end, input.working_days]
    );
    return rows[0];
  }

  // =========================================================================
  // ATTENDANCE
  // =========================================================================

  async markAttendance(input: MarkAttendanceInput): Promise<void> {
    await this.assertEmployeeBelongsToTenant(input.employee_id, input.tenant_id);
    await this.assertPayPeriodBelongsToTenant(input.pay_period_id, input.tenant_id);

    await this.client.query(
      `INSERT INTO attendance_logs (employee_id, pay_period_id, tenant_id, attendance_date, status, hours_worked, lop_days)
       VALUES ($1,$2,$3,$4,$5,$6,
         CASE
           WHEN $5 = 'PRESENT' THEN 0
           WHEN $5 = 'HALF_DAY' THEN 0.5
           WHEN $5 IN ('ABSENT', 'UNPAID_LEAVE') THEN 1
           ELSE 0
         END)
       ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
         status = EXCLUDED.status,
         hours_worked = EXCLUDED.hours_worked,
         lop_days = EXCLUDED.lop_days,
         updated_at = now()`,
      [input.employee_id, input.pay_period_id, input.tenant_id, input.attendance_date, input.status, input.hours_worked ?? null]
    );
  }

  // =========================================================================
  // RUN PAYROLL — The Core Engine
  // =========================================================================

  /**
   * Computes payroll for ALL active employees in a pay period.
   * Creates payroll_run + payroll_run_details rows.
   * Status: DRAFT → COMPUTED.
   */
  async runPayroll(input: RunPayrollInput): Promise<PayrollRunResult> {
    const engine = new PayrollEngine(this.client);

    // Load pay period
    const { rows: ppRows } = await this.client.query<PayPeriodRow>(
      `SELECT * FROM pay_periods WHERE pay_period_id = $1 AND tenant_id = $2`,
      [input.pay_period_id, input.tenant_id]
    );
    if (ppRows.length === 0) throw new Error("Pay period not found");
    const period = ppRows[0];

    if (period.is_closed) throw new Error("Pay period is already closed");

    // Load active employees
    const employees = await this.listEmployees(input.tenant_id, "ACTIVE");
    if (employees.length === 0) throw new Error("No active employees found");

    // Create payroll run header
    const description = input.run_description ?? `Salary for ${period.period_name}`;
    await this.client.query(
      `INSERT INTO payroll_runs (tenant_id, pay_period_id, run_description, run_date, status)
       VALUES ($1,$2,$3,CURRENT_DATE,'DRAFT')
       ON CONFLICT (tenant_id, pay_period_id) DO UPDATE SET
         run_description = EXCLUDED.run_description,
         run_date = EXCLUDED.run_date,
         status = 'DRAFT',
         updated_at = now()`,
      [input.tenant_id, input.pay_period_id, description]
    );

    const { rows: runRows } = await this.client.query<PayrollRunRow>(
      `SELECT * FROM payroll_runs WHERE tenant_id = $1 AND pay_period_id = $2`,
      [input.tenant_id, input.pay_period_id]
    );
    const run = runRows[0];

    // Compute for each employee
    const details: EmployeePayrollResult[] = [];
    for (const emp of employees) {
      try {
        const result = await engine.computeEmployeePay(
          emp.employee_id,
          input.pay_period_id,
          period.working_days,
          input.tenant_id
        );
        details.push(result);

        // Persist detail row
        await this.client.query(
          `INSERT INTO payroll_run_details (
             payroll_run_id, employee_id, tenant_id,
             days_present, days_absent, lop_days, days_payable,
             basic_wage, hra, conveyance, special_allowance, other_earnings, gross_earnings,
             employee_pf, employee_esi, professional_tax, income_tax_tds, other_deductions, total_deductions,
             employer_pf, employer_esi,
             net_pay, pf_wage, esi_wage
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           ON CONFLICT (payroll_run_id, employee_id) DO UPDATE SET
             days_present = EXCLUDED.days_present,
             lop_days = EXCLUDED.lop_days,
             days_payable = EXCLUDED.days_payable,
             basic_wage = EXCLUDED.basic_wage,
             gross_earnings = EXCLUDED.gross_earnings,
             employee_pf = EXCLUDED.employee_pf,
             employee_esi = EXCLUDED.employee_esi,
             professional_tax = EXCLUDED.professional_tax,
             income_tax_tds = EXCLUDED.income_tax_tds,
             other_deductions = EXCLUDED.other_deductions,
             total_deductions = EXCLUDED.total_deductions,
             employer_pf = EXCLUDED.employer_pf,
             employer_esi = EXCLUDED.employer_esi,
             net_pay = EXCLUDED.net_pay,
             pf_wage = EXCLUDED.pf_wage,
             esi_wage = EXCLUDED.esi_wage,
             metadata = jsonb_build_object('recalculated_at', now())`,
          [
            run.payroll_run_id, emp.employee_id, input.tenant_id,
            result.days_present, result.days_absent, result.lop_days, result.days_payable,
            result.basic_wage, result.hra, result.conveyance, result.special_allowance,
            result.other_earnings, result.gross_earnings,
            result.statutory.employee_pf, result.statutory.employee_esi,
            result.statutory.professional_tax, result.statutory.income_tax_tds,
            result.other_deductions, result.total_deductions,
            result.employer_pf, result.employer_esi,
            result.net_pay, result.statutory.pf_wage, result.statutory.esi_wage,
          ]
        );
      } catch (err) {
        console.error(`Failed to compute payroll for employee ${emp.employee_code}: ${err instanceof Error ? err.message : String(err)}`);
        // Continue processing other employees
      }
    }

    // Compute aggregates
    const summary = this.aggregatePayroll(details);

    // Update payroll run header
    await this.client.query(
      `UPDATE payroll_runs SET
         total_gross_salary = $2, total_employer_pf = $3, total_employer_esi = $4,
         total_employee_pf = $5, total_employee_esi = $6, total_professional_tax = $7,
         total_income_tax_tds = $8, total_net_pay = $9,
         status = 'COMPUTED',
         status_history = status_history || jsonb_build_object('status','COMPUTED','timestamp',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'actor','system'),
         updated_at = now()
       WHERE payroll_run_id = $1`,
      [
        run.payroll_run_id,
        summary.total_gross_salary, summary.total_employer_pf, summary.total_employer_esi,
        summary.total_employee_pf, summary.total_employee_esi, summary.total_professional_tax,
        summary.total_income_tax_tds, summary.total_net_pay,
      ]
    );

    return {
      payroll_run_id: run.payroll_run_id,
      pay_period_id: period.pay_period_id,
      period_name: period.period_name,
      run_description: description,
      employee_count: details.length,
      summary,
      details,
    };
  }

  /**
   * Approve payroll → triggers auto-journal via DB trigger.
   */
  async approvePayroll(input: ApprovePayrollInput, tenantId: string): Promise<{
    payroll_run_id: number;
    status: string;
    transaction_id: number | null;
    journal: JournalSummary | null;
  }> {
    const { rows } = await this.client.query<PayrollRunRow>(
      `SELECT * FROM payroll_runs WHERE payroll_run_id = $1 AND tenant_id = $2`,
      [input.payroll_run_id, tenantId]
    );
    const run = rows[0];
    if (!run) throw new Error("Payroll run not found");
    if (run.status !== "COMPUTED") throw new Error("Only COMPUTED payroll runs can be approved");

    // Approve — this fires trg_payroll_auto_journal → creates txn + journal lines
    await this.client.query(
      `UPDATE payroll_runs
        SET status = 'APPROVED',
           approved_by = $2,
           approved_at = now(),
           status_history = status_history || jsonb_build_object(
             'status','APPROVED','timestamp',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'actor',$2
           ),
           updated_at = now()
        WHERE payroll_run_id = $1 AND tenant_id = $3`,
      [input.payroll_run_id, input.approved_by, tenantId]
    );

    // Read the generated transaction
    const { rows: updated } = await this.client.query<PayrollRunRow>(
      `SELECT * FROM payroll_runs WHERE payroll_run_id = $1 AND tenant_id = $2`,
      [input.payroll_run_id, tenantId]
    );
    const updatedRun = updated[0];

    let journal: JournalSummary | null = null;
    if (updatedRun.transaction_id) {
      const { rows: jeRows } = await this.client.query<{
        account_id: number;
        account_name: string;
        debit_amount: string;
        credit_amount: string;
        description: string;
      }>(
        `SELECT je.account_id, a.account_name, je.debit_amount, je.credit_amount, je.description
         FROM journal_entries je
         JOIN accounts a ON a.account_id = je.account_id
         WHERE je.transaction_id = $1
         ORDER BY je.entry_id`,
        [updatedRun.transaction_id]
      );
      journal = {
        transaction_id: updatedRun.transaction_id,
        entries: jeRows.map((r) => ({
          account_id: r.account_id,
          account_name: r.account_name,
          debit: Number(r.debit_amount),
          credit: Number(r.credit_amount),
          description: r.description ?? "",
        })),
      };
    }

    return {
      payroll_run_id: updatedRun.payroll_run_id,
      status: updatedRun.status,
      transaction_id: updatedRun.transaction_id,
      journal,
    };
  }

  /**
   * Get a complete salary register for a payroll run.
   */
  async getSalaryRegister(payrollRunId: number, tenantId: string): Promise<PayrollRunResult> {
    const { rows: runRows } = await this.client.query<PayrollRunRow>(
      `SELECT * FROM payroll_runs WHERE payroll_run_id = $1 AND tenant_id = $2`,
      [payrollRunId, tenantId]
    );
    if (runRows.length === 0) throw new Error("Payroll run not found");
    const run = runRows[0];

    const { rows: ppRows } = await this.client.query<PayPeriodRow>(
      `SELECT * FROM pay_periods WHERE pay_period_id = $1 AND tenant_id = $2`,
      [run.pay_period_id, tenantId]
    );

    const { rows: detailRows } = await this.client.query<PayrollRunDetailRow>(
      `SELECT prd.*, e.employee_code, e.first_name, e.last_name, e.pan, e.uan, e.esi_ip_number, e.bank_account_number
       FROM payroll_run_details prd
       JOIN employees e ON e.employee_id = prd.employee_id
       WHERE prd.payroll_run_id = $1 AND prd.tenant_id = $2
       ORDER BY e.employee_code`,
      [payrollRunId, tenantId]
    );

    const details: EmployeePayrollResult[] = detailRows.map((d) => {
      const row = d as PayrollRunDetailRow & { employee_code: string; first_name: string; last_name: string | null; pan: string | null; uan: string | null; esi_ip_number: string | null; bank_account_number: string | null };
      return {
        employee_id: row.employee_id,
        employee_code: row.employee_code,
        employee_name: `${row.first_name} ${row.last_name ?? ""}`.trim(),
        days_present: Number(row.days_present),
        days_absent: Number(row.days_absent),
        lop_days: Number(row.lop_days),
        days_payable: Number(row.days_payable),
        earnings: [],
        basic_wage: Number(row.basic_wage),
        hra: Number(row.hra),
        conveyance: Number(row.conveyance),
        special_allowance: Number(row.special_allowance),
        other_earnings: Number(row.other_earnings),
        gross_earnings: Number(row.gross_earnings),
        statutory: {
          pf_wage: Number(row.pf_wage),
          employee_pf: Number(row.employee_pf),
          employer_pf: Number(row.employer_pf),
          employer_eps: 0,
          total_pf: Number(row.employee_pf) + Number(row.employer_pf),
          esi_wage: Number(row.esi_wage),
          employee_esi: Number(row.employee_esi),
          employer_esi: Number(row.employer_esi),
          total_esi: Number(row.employee_esi) + Number(row.employer_esi),
          professional_tax: Number(row.professional_tax),
          pt_slab: "",
          income_tax_tds: Number(row.income_tax_tds),
          annual_tax: 0,
          cess_amount: 0,
          total_deductions: Number(row.total_deductions),
          total_employer_contributions: Number(row.employer_pf) + Number(row.employer_esi),
        },
        other_deductions: Number(row.other_deductions),
        total_deductions: Number(row.total_deductions),
        employer_pf: Number(row.employer_pf),
        employer_esi: Number(row.employer_esi),
        net_pay: Number(row.net_pay),
        pan: row.pan,
        uan: row.uan,
        esi_ip_number: row.esi_ip_number,
        bank_account_number: row.bank_account_number,
      };
    });

    return {
      payroll_run_id: run.payroll_run_id,
      pay_period_id: run.pay_period_id,
      period_name: ppRows[0]?.period_name ?? "",
      run_description: run.run_description,
      employee_count: details.length,
      summary: {
        total_gross_salary: Number(run.total_gross_salary),
        total_employer_pf: Number(run.total_employer_pf),
        total_employer_esi: Number(run.total_employer_esi),
        total_employee_pf: Number(run.total_employee_pf),
        total_employee_esi: Number(run.total_employee_esi),
        total_professional_tax: Number(run.total_professional_tax),
        total_income_tax_tds: Number(run.total_income_tax_tds),
        total_net_pay: Number(run.total_net_pay),
      },
      details,
      journal_entry: run.transaction_id ? {
        transaction_id: run.transaction_id,
        entries: [],
      } : undefined,
    };
  }

  private async assertEmployeeBelongsToTenant(employeeId: number, tenantId: string): Promise<void> {
    const { rows } = await this.client.query<{ employee_id: number }>(
      `SELECT employee_id FROM employees WHERE employee_id = $1 AND tenant_id = $2`,
      [employeeId, tenantId]
    );

    if (rows.length === 0) {
      throw new Error("Employee not found for this tenant");
    }
  }

  private async assertPayPeriodBelongsToTenant(payPeriodId: number, tenantId: string): Promise<void> {
    const { rows } = await this.client.query<{ pay_period_id: number }>(
      `SELECT pay_period_id FROM pay_periods WHERE pay_period_id = $1 AND tenant_id = $2`,
      [payPeriodId, tenantId]
    );

    if (rows.length === 0) {
      throw new Error("Pay period not found for this tenant");
    }
  }

  // =========================================================================
  // PRIVATE
  // =========================================================================

  private aggregatePayroll(details: EmployeePayrollResult[]) {
    return {
      total_gross_salary: this.sum(details, "gross_earnings"),
      total_employer_pf: this.sum(details, "employer_pf"),
      total_employer_esi: this.sum(details, "employer_esi"),
      total_employee_pf: details.reduce((s, d) => s + d.statutory.employee_pf, 0),
      total_employee_esi: details.reduce((s, d) => s + d.statutory.employee_esi, 0),
      total_professional_tax: details.reduce((s, d) => s + d.statutory.professional_tax, 0),
      total_income_tax_tds: details.reduce((s, d) => s + d.statutory.income_tax_tds, 0),
      total_net_pay: details.reduce((s, d) => s + d.net_pay, 0),
    };
  }

  private sum(details: EmployeePayrollResult[], key: keyof EmployeePayrollResult): number {
    return details.reduce((s, d) => s + (d[key] as number), 0);
  }
}

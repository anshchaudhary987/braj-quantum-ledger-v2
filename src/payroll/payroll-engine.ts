// ============================================================================
// PAYROLL ENGINE — PF/ESI/PT/TDS Computation + LOP Adjustment
//
// Statutory Logic:
//   PF  = 12% of (Basic + DA), capped at ₹15,000/month
//         Employer: 3.67% PF + 8.33% EPS + 0.5% Admin + 0.5% EDLI
//   ESI = 0.75% (employee) + 3.25% (employer) on Gross Wage ≤ ₹21,000
//   PT  = State-specific slab rates (fixed ₹ per month from statutory_rates)
//   TDS = Projected annual income → IT slab → monthly deduction
//
// LOP Adjustment:
//   Adjusted Amount = (Gross Salary / Working Days) × (Working Days - LOP Days)
// ============================================================================

import { PoolClient } from "pg";
import {
  EmployeeRow,
  SalaryStructureRow,
  StatutoryRateRow,
  SalaryComponentResult,
  StatutoryDeductions,
  EmployeePayrollResult,
} from "./payroll-types.js";

export class PayrollEngine {
  constructor(private readonly client: PoolClient) {}

  /**
   * Compute payroll for a single employee in a given pay period.
   *
   * Steps:
   *  1. Load salary structure (active components)
   *  2. Load attendance → LOP days
   *  3. Adjust gross salary for LOP
   *  4. Compute PF, ESI, PT, TDS
   *  5. Return comprehensive breakdown
   */
  async computeEmployeePay(
    employeeId: number,
    payPeriodId: number,
    workingDays: number,
    tenantId?: string
  ): Promise<EmployeePayrollResult> {
    // ── Step 1: Load employee ──
    const emp = await this.loadEmployee(employeeId, tenantId);

    // ── Step 2: Load salary structure ──
    const components = await this.loadSalaryStructure(employeeId, tenantId);

    // ── Step 3: Load attendance ──
    const { daysPresent, daysAbsent, lopDays, daysPayable } =
      await this.loadAttendance(employeeId, payPeriodId, workingDays, tenantId);

    // ── Step 4: Compute earnings components ──
    const earnings = this.computeEarnings(components, workingDays, lopDays);

    const basicWage = this.findComponentAmount(earnings, "BASIC") +
                      this.findComponentAmount(earnings, "DA");
    const hra = this.findComponentAmount(earnings, "HRA");
    const conveyance = this.findComponentAmount(earnings, "CONVEYANCE");
    const specialAllowance = this.findComponentAmount(earnings, "SPECIAL_ALLOWANCE");
    const otherEarnings = earnings
      .filter((e) => !["BASIC", "DA", "HRA", "CONVEYANCE", "SPECIAL_ALLOWANCE"].includes(e.component_name))
      .reduce((s, e) => s + e.amount, 0);

    const grossEarnings = earnings.reduce((s, e) => s + e.amount, 0);

    // ── Step 5: Compute statutory deductions ──
    const statutory = await this.computeStatutoryDeductions(
      basicWage,
      grossEarnings,
      emp
    );

    // ── Step 6: Load deductions components (voluntary: loans, advances, etc.) ──
    const deductions = components.filter((c) => c.component_type === "DEDUCTION");
    // Note: statutory deductions (PF, ESI, PT, TDS) are separate from voluntary deductions
    const otherDeductions = deductions.reduce((s, d) => {
      const amount = d.is_percentage
        ? (Number(d.amount_or_percent) * grossEarnings) / 100
        : Number(d.amount_or_percent);
      return s + amount;
    }, 0);

    const totalDeductions = statutory.total_deductions + otherDeductions;
    const employerPfContribution = statutory.employer_pf;
    const employerEsiContribution = statutory.employer_esi;
    const netPay = Math.max(grossEarnings - totalDeductions, 0);

    return {
      employee_id: employeeId,
      employee_code: emp.employee_code,
      employee_name: `${emp.first_name} ${emp.last_name ?? ""}`.trim(),
      days_present: daysPresent,
      days_absent: daysAbsent,
      lop_days: lopDays,
      days_payable: daysPayable,
      earnings,
      basic_wage: basicWage,
      hra,
      conveyance,
      special_allowance: specialAllowance,
      other_earnings: otherEarnings,
      gross_earnings: this.round(grossEarnings),
      statutory,
      other_deductions: this.round(otherDeductions),
      total_deductions: this.round(totalDeductions),
      employer_pf: employerPfContribution,
      employer_esi: employerEsiContribution,
      net_pay: this.round(netPay),
      pan: emp.pan,
      uan: emp.uan,
      esi_ip_number: emp.esi_ip_number,
      bank_account_number: emp.bank_account_number,
    };
  }

  // =========================================================================
  // PRIVATE — Data Loading
  // =========================================================================

  private async loadEmployee(employeeId: number, tenantId?: string): Promise<EmployeeRow> {
    const { rows } = await this.client.query<EmployeeRow>(
      `SELECT * FROM employees
       WHERE employee_id = $1
         ${tenantId ? "AND tenant_id = $2" : ""}`,
      tenantId ? [employeeId, tenantId] : [employeeId]
    );
    if (rows.length === 0) throw new Error(`Employee not found: ${employeeId}`);
    return rows[0];
  }

  private async loadSalaryStructure(employeeId: number, tenantId?: string): Promise<SalaryStructureRow[]> {
    const { rows } = await this.client.query<SalaryStructureRow>(
      `SELECT * FROM salary_structures
       WHERE employee_id = $1 AND is_active = TRUE
         ${tenantId ? "AND tenant_id = $2" : ""}
         AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY component_type, component_name`,
      tenantId ? [employeeId, tenantId] : [employeeId]
    );
    return rows;
  }

  private async loadAttendance(
    employeeId: number,
    payPeriodId: number,
    workingDays: number,
    tenantId?: string
  ): Promise<{
    daysPresent: number;
    daysAbsent: number;
    lopDays: number;
    daysPayable: number;
  }> {
    const { rows } = await this.client.query<{
      days_present: string;
      days_absent: string;
      lop_days: string;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('PRESENT') THEN 1
                           WHEN status = 'HALF_DAY' THEN 0.5
                           WHEN status IN ('PAID_LEAVE', 'WEEKLY_OFF', 'HOLIDAY') THEN 1
                           ELSE 0 END), 0) AS days_present,
         COALESCE(SUM(CASE WHEN status IN ('ABSENT', 'UNPAID_LEAVE') THEN 1 END), 0) AS days_absent,
         COALESCE(SUM(CASE WHEN status IN ('ABSENT', 'UNPAID_LEAVE') THEN 1
                           WHEN status = 'HALF_DAY' THEN 0.5
                           ELSE 0 END), 0) AS lop_days
       FROM attendance_logs
       WHERE employee_id = $1 AND pay_period_id = $2
         ${tenantId ? "AND tenant_id = $3" : ""}`,
      tenantId ? [employeeId, payPeriodId, tenantId] : [employeeId, payPeriodId]
    );
    const r = rows[0];
    const dp = Number(r?.days_present ?? 0);
    const da = Number(r?.days_absent ?? 0);
    const lop = Number(r?.lop_days ?? 0);

    return {
      daysPresent: dp,
      daysAbsent: da,
      lopDays: lop,
      daysPayable: Math.max(workingDays - lop, 0),
    };
  }

  // =========================================================================
  // PRIVATE — Earnings Computation (with LOP)
  // =========================================================================

  private computeEarnings(
    components: SalaryStructureRow[],
    workingDays: number,
    lopDays: number
  ): SalaryComponentResult[] {
    const earningComponents = components.filter(
      (c) => c.component_type === "EARNING"
    );

    // First pass: find BASIC amount (needed for percentage-based components)
    const basicComponent = earningComponents.find(
      (c) => c.component_name === "BASIC"
    );
    const baseWage = basicComponent
      ? Number(basicComponent.amount_or_percent)
      : 0;

    return earningComponents.map((comp) => {
      let amount: number;

      if (comp.is_percentage) {
        // Percentage-based: reference base_wage_ref or BASIC
        const refComp =
          comp.base_wage_ref && comp.base_wage_ref !== comp.component_name
            ? earningComponents.find((e) => e.component_name === comp.base_wage_ref)
            : null;

        const refAmount = refComp
          ? Number(refComp.amount_or_percent)
          : baseWage;

        amount = (Number(comp.amount_or_percent) * refAmount) / 100;
      } else {
        amount = Number(comp.amount_or_percent);
      }

      // Adjust for LOP: prorate salary based on days present
      if (workingDays > 0 && lopDays > 0) {
        amount = this.adjustForLOP(amount, workingDays, lopDays);
      }

      // Round down for statutory components
      amount = Math.floor(amount);

      return {
        component_name: comp.component_name,
        component_type: "EARNING",
        amount,
        statutory_tag: comp.statutory_tag,
      };
    });
  }

  private findComponentAmount(earnings: SalaryComponentResult[], name: string): number {
    return earnings.find((e) => e.component_name === name)?.amount ?? 0;
  }

  private adjustForLOP(
    grossAmount: number,
    workingDays: number,
    lopDays: number
  ): number {
    if (workingDays <= 0 || lopDays <= 0) return grossAmount;
    return Math.round(
      (grossAmount * (workingDays - lopDays)) / workingDays
    );
  }

  // =========================================================================
  // PRIVATE — Statutory Deductions
  // =========================================================================

  private async computeStatutoryDeductions(
    basicPlusDA: number,
    grossEarnings: number,
    emp: EmployeeRow
  ): Promise<StatutoryDeductions> {
    // ── PF Computation ──
    const pfEligible = emp.pf_applicability !== "EXEMPT" && emp.pf_applicability !== "EXCLUDED";
    const { rows: pfRows } = await this.client.query<{
      pf_wage: string;
      employee_pf: string;
      employer_pf: string;
      employer_eps: string;
      total_pf: string;
    }>(`SELECT * FROM compute_pf($1, $2)`, [basicPlusDA, pfEligible]);

    const pf = pfRows[0];
    const employeePf = Number(pf?.employee_pf ?? 0);
    const employerPf = Number(pf?.employer_pf ?? 0);
    const employerEps = Number(pf?.employer_eps ?? 0);
    const totalPf = Number(pf?.total_pf ?? 0);
    const pfWage = Number(pf?.pf_wage ?? 0);

    // ── ESI Computation ──
    const esiEligible = emp.esi_applicability === "COVERED";
    const { rows: esiRows } = await this.client.query<{
      esi_wage: string;
      employee_esi: string;
      employer_esi: string;
      total_esi: string;
    }>(`SELECT * FROM compute_esi($1, $2)`, [grossEarnings, esiEligible]);

    const esi = esiRows[0];
    const employeeEsi = Number(esi?.employee_esi ?? 0);
    const employerEsi = Number(esi?.employer_esi ?? 0);
    const totalEsi = Number(esi?.total_esi ?? 0);
    const esiWage = Number(esi?.esi_wage ?? 0);

    // ── Professional Tax ──
    const ptEligible = emp.is_eligible_for_pt && emp.work_location_state !== null;
    let professionalTax = 0;
    let ptSlab = "N/A";
    if (ptEligible) {
      const { rows: ptRows } = await this.client.query<{
        pt_amount: string;
        slab_used: string;
      }>(
        `SELECT * FROM compute_professional_tax($1, $2)`,
        [grossEarnings, emp.work_location_state]
      );
      if (ptRows.length > 0) {
        professionalTax = Number(ptRows[0].pt_amount);
        ptSlab = ptRows[0].slab_used;
      }
    }

    // ── Income Tax TDS ──
    // Simplified: projected annual = (current month gross × remaining months)
    //              + previous month's actual grosses (for cumulative)
    const projectedAnnual = grossEarnings * 12; // simplified — should be cumulative
    const { rows: tdsRows } = await this.client.query<{
      monthly_tds: string;
      annual_tax: string;
      cess_amount: string;
      slab_description: string;
    }>(
      `SELECT * FROM compute_income_tax_tds($1, $2, $3)`,
      [grossEarnings, projectedAnnual - Number(emp.declared_investments ?? 0), emp.tax_regime]
    );

    const tds = tdsRows[0];
    const incomeTaxTds = Number(tds?.monthly_tds ?? 0);
    const annualTax = Number(tds?.annual_tax ?? 0);
    const cess = Number(tds?.cess_amount ?? 0);

    // ── Totals ──
    const totalDeductions = employeePf + employeeEsi + professionalTax + incomeTaxTds;
    const totalEmployerContributions = employerPf + employerEps + employerEsi;

    return {
      pf_wage: pfWage,
      employee_pf: employeePf,
      employer_pf: employerPf,
      employer_eps: employerEps,
      total_pf: totalPf,
      esi_wage: esiWage,
      employee_esi: employeeEsi,
      employer_esi: employerEsi,
      total_esi: totalEsi,
      professional_tax: professionalTax,
      pt_slab: ptSlab,
      income_tax_tds: incomeTaxTds,
      annual_tax: annualTax,
      cess_amount: cess,
      total_deductions: this.round(totalDeductions),
      total_employer_contributions: this.round(totalEmployerContributions),
    };
  }

  // =========================================================================
  // PRIVATE — Utilities
  // =========================================================================

  private round(val: number): number {
    return Math.round(val * 100) / 100;
  }
}

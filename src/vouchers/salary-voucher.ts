// ============================================================================
// SALARY VOUCHER STRATEGY
//
// Translates a payroll result into a balanced double-entry journal.
//
// Debit side (Expenses):
//   Dr Salary Expense A/c          — Gross Salary (sum of all employee earnings)
//   Dr Employer PF Contribution   — Employer's 3.67% PF + 8.33% EPS
//   Dr Employer ESI Contribution  — Employer's 3.25% ESI
//
// Credit side (Liabilities):
//   Cr Salary Payable A/c         — Net pay to employees
//   Cr EPF Payable A/c            — Employee PF + Employer PF + EPS
//   Cr ESI Payable A/c            — Employee ESI + Employer ESI
//   Cr PT Payable A/c             — Professional Tax
//   Cr TDS Payable A/c            — Income Tax TDS (u/s 192)
//
// Expected payload:
// {
//   salary_expense_account_id: number,    // e.g. 4001 — Salaries Expense
//   empr_pf_expense_account_id: number,   // e.g. 4002 — Employer PF Contribution
//   empr_esi_expense_account_id: number,  // e.g. 4003 — Employer ESI Contribution
//   salary_payable_account_id: number,    // e.g. 2001 — Salary Payable
//   epf_payable_account_id: number,       // e.g. 2002 — EPF Payable
//   esi_payable_account_id: number,       // e.g. 2003 — ESI Payable
//   pt_payable_account_id: number,        // e.g. 2004 — PT Payable
//   tds_payable_account_id: number,       // e.g. 2005 — TDS Payable
//   gross_salary: number,
//   employer_pf: number,
//   employer_esi: number,
//   employee_pf: number,
//   employee_esi: number,
//   professional_tax: number,
//   income_tax_tds: number,
//   net_pay: number,
//   payroll_run_id: number,
//   narration?: string
// }
// ============================================================================

import { PoolClient } from "pg";
import { VoucherStrategy } from "./voucher-strategy.js";
import { JournalLine, VoucherPayload } from "../models/types.js";

export class SalaryVoucherStrategy implements VoucherStrategy {
  readonly voucherType = "SALARY_VOUCHER";

  async translate(
    _client: PoolClient,
    payload: VoucherPayload,
    _tenantId: string,
    _txnDate: string
  ): Promise<JournalLine[]> {
    const salaryExp   = Number(payload.salary_expense_account_id);
    const emprPfExp   = Number(payload.empr_pf_expense_account_id);
    const emprEsiExp  = Number(payload.empr_esi_expense_account_id);
    const salaryPay   = Number(payload.salary_payable_account_id);
    const epfPay      = Number(payload.epf_payable_account_id);
    const esiPay      = Number(payload.esi_payable_account_id);
    const ptPay       = Number(payload.pt_payable_account_id);
    const tdsPay      = Number(payload.tds_payable_account_id);

    const grossSalary = Number(payload.gross_salary);
    const employerPf  = Number(payload.employer_pf);
    const employerEsi = Number(payload.employer_esi);
    const employeePf  = Number(payload.employee_pf);
    const employeeEsi = Number(payload.employee_esi);
    const profTax     = Number(payload.professional_tax);
    const incomeTds   = Number(payload.income_tax_tds);
    const netPay      = Number(payload.net_pay);
    const narration   = String(payload.narration ?? "Monthly Salary — Auto-generated");

    // Validate accounts
    const requiredAccounts = [
      salaryExp, emprPfExp, emprEsiExp,
      salaryPay, epfPay, esiPay, ptPay, tdsPay,
    ];
    if (requiredAccounts.some((a) => !a || a <= 0)) {
      throw new Error("SALARY_VOUCHER requires all 8 ledger account IDs to be valid");
    }

    if (grossSalary <= 0) {
      throw new Error("SALARY_VOUCHER requires gross_salary > 0");
    }

    // Build balanced journal lines
    const totalEpfPayable = employeePf + employerPf;
    const totalEsiPayable = employeeEsi + employerEsi;

    const lines: JournalLine[] = [
      // ── DEBIT side: Expenses ──
      {
        account_id: salaryExp,
        debit_amount: grossSalary,
        credit_amount: 0,
        description: `${narration} — Gross Salary`,
      },
      {
        account_id: emprPfExp,
        debit_amount: employerPf,
        credit_amount: 0,
        description: `${narration} — Employer PF Contribution`,
      },
      {
        account_id: emprEsiExp,
        debit_amount: employerEsi,
        credit_amount: 0,
        description: `${narration} — Employer ESI Contribution`,
      },

      // ── CREDIT side: Liabilities ──
      {
        account_id: salaryPay,
        debit_amount: 0,
        credit_amount: netPay,
        description: `${narration} — Net Salary Payable to Employees`,
      },
      {
        account_id: epfPay,
        debit_amount: 0,
        credit_amount: totalEpfPayable,
        description: `${narration} — EPF Remittance (EE+ER)`,
      },
      {
        account_id: esiPay,
        debit_amount: 0,
        credit_amount: totalEsiPayable,
        description: `${narration} — ESI Remittance (EE+ER)`,
      },
      {
        account_id: ptPay,
        debit_amount: 0,
        credit_amount: profTax,
        description: `${narration} — Professional Tax Payable`,
      },
      {
        account_id: tdsPay,
        debit_amount: 0,
        credit_amount: incomeTds,
        description: `${narration} — TDS on Salary (u/s 192)`,
      },
    ];

    // Remove zero-amount lines for cleaner journal
    return lines.filter((l) => l.debit_amount > 0 || l.credit_amount > 0);
  }
}

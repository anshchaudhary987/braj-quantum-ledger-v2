// ============================================================================
// PAYROLL & HRMS — Express API Routes
// ============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ErrorCode } from "../errors";
import { AppError } from "../auth/auth-service";
import { validate } from "../middleware/validate";
import { requireAuth, requireRole, setSecurityContext } from "../auth/auth-middleware";
import { voucherRateLimiter } from "../middleware/rate-limiter-redis";
import { withClient, withTransaction } from "../../db/pool";
import { PoolClient } from "pg";
import { PayrollService } from "../../payroll/payroll-service";
import { PayrollEngine } from "../../payroll/payroll-engine";
import { SalaryVoucherStrategy } from "../../vouchers/salary-voucher";
import { VoucherFactory } from "../../vouchers/voucher-factory";
import {
  CreateEmployeeInput,
  CreateSalaryStructureInput,
  CreatePayPeriodInput,
  MarkAttendanceInput,
  RunPayrollInput,
  ApprovePayrollInput,
} from "../../payroll/payroll-types";

const router = Router();
const canManagePayroll = requireRole("OWNER", "ADMIN", "ACCOUNTANT");

// Register the Salary Voucher strategy at module load
VoucherFactory.register(new SalaryVoucherStrategy());

// ─────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────

const createEmployeeSchema = z.object({
  body: z.object({
    employee_code: z.string().min(1).max(30),
    first_name: z.string().min(1).max(100),
    last_name: z.string().max(100).optional(),
    date_of_joining: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pan: z.string().length(10).optional(),
    uan: z.string().length(12).optional(),
    pf_number: z.string().max(25).optional(),
    esi_ip_number: z.string().max(17).optional(),
    work_location_state: z.string().length(2).optional(),
    bank_account_number: z.string().max(34).optional(),
    bank_ifsc: z.string().max(11).optional(),
    employee_account_id: z.number().int().positive().optional(),
    pf_applicability: z.enum(["FULL", "RESTRICTED", "EXCLUDED", "EXEMPT"]).default("FULL"),
    esi_applicability: z.enum(["COVERED", "EXCLUDED", "EXEMPT"]).default("COVERED"),
    tax_regime: z.enum(["NEW", "OLD"]).default("NEW"),
    declared_investments: z.number().min(0).default(0),
  }),
});

const salaryStructureSchema = z.object({
  body: z.object({
    employee_id: z.number().int().positive(),
    components: z.array(
      z.object({
        component_name: z.string().min(1).max(50),
        component_type: z.enum(["EARNING", "DEDUCTION"]),
        statutory_tag: z.string().max(30).optional(),
        amount_or_percent: z.number().min(0),
        is_percentage: z.boolean(),
        base_wage_ref: z.string().max(30).optional(),
      })
    ).min(1),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});

const payPeriodSchema = z.object({
  body: z.object({
    period_name: z.string().min(1).max(20),
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    working_days: z.number().int().min(1).max(31),
  }),
});

const attendanceSchema = z.object({
  body: z.object({
    employee_id: z.number().int().positive(),
    pay_period_id: z.number().int().positive(),
    attendance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(["PRESENT", "ABSENT", "HALF_DAY", "PAID_LEAVE", "UNPAID_LEAVE", "WEEKLY_OFF", "HOLIDAY"]),
    hours_worked: z.number().min(0).max(24).optional(),
  }),
});

const batchAttendanceSchema = z.object({
  body: z.object({
    pay_period_id: z.number().int().positive(),
    entries: z.array(
      z.object({
        employee_id: z.number().int().positive(),
        attendance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: z.enum(["PRESENT", "ABSENT", "HALF_DAY", "PAID_LEAVE", "UNPAID_LEAVE", "WEEKLY_OFF", "HOLIDAY"]),
        hours_worked: z.number().min(0).max(24).optional(),
      })
    ).min(1),
  }),
});

const runPayrollSchema = z.object({
  body: z.object({
    pay_period_id: z.number().int().positive(),
    run_description: z.string().max(200).optional(),
  }),
});

const approvePayrollSchema = z.object({
  body: z.object({
    payroll_run_id: z.number().int().positive(),
    approved_by: z.string().min(1).max(100),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/employees
// Create a new employee.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/employees",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(createEmployeeSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: CreateEmployeeInput = {
        ...req.body,
        tenant_id: String(req.companyId!),
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          return service.createEmployee(input);
        });
      });

      res.status(201).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/payroll/employees
// List all employees (optionally filter by status).
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/employees",
  requireAuth,
  canManagePayroll,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string | undefined;

      const result = await withClient(async (conn) => {
        const service = new PayrollService(conn);
        return service.listEmployees(String(req.companyId!), status);
      });

      res.json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/payroll/employees/:id
// Get a single employee.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/employees/:id",
  requireAuth,
  canManagePayroll,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid employee ID");

      const result = await withClient(async (conn) => {
        const service = new PayrollService(conn);
        const emp = await service.getEmployee(id, String(req.companyId!));
        if (!emp) throw new AppError(ErrorCode.NOT_FOUND, `Employee not found: ${id}`);
        return emp;
      });

      res.json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/salary-structure
// Set salary structure for an employee.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/salary-structure",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(salaryStructureSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: CreateSalaryStructureInput = {
        ...req.body,
        tenant_id: String(req.companyId!),
      };

      const count = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          return service.setSalaryStructure(input);
        });
      });

      res.status(201).json({
        data: { components_created: count, employee_id: input.employee_id },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/pay-periods
// Create a new pay period.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/pay-periods",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(payPeriodSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: CreatePayPeriodInput = {
        ...req.body,
        tenant_id: String(req.companyId!),
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          return service.createPayPeriod(input);
        });
      });

      res.status(201).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/attendance
// Mark a single day's attendance for an employee.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/attendance",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(attendanceSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: MarkAttendanceInput = {
        tenant_id: String(req.companyId!),
        employee_id: req.body.employee_id,
        pay_period_id: req.body.pay_period_id,
        attendance_date: req.body.attendance_date,
        status: req.body.status,
        hours_worked: req.body.hours_worked,
      };

      await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          return service.markAttendance(input);
        });
      });

      res.status(201).json({
        data: { marked: true, employee_id: input.employee_id, date: input.attendance_date },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/attendance/batch
// Mark attendance for multiple employees in one call.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/attendance/batch",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(batchAttendanceSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pay_period_id, entries } = req.body;
      let marked = 0;

      await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          for (const entry of entries) {
            await service.markAttendance({
              tenant_id: String(req.companyId!),
              employee_id: entry.employee_id,
              pay_period_id,
              attendance_date: entry.attendance_date,
              status: entry.status,
              hours_worked: entry.hours_worked,
            });
            marked++;
          }
        });
      });

      res.status(201).json({
        data: { marked, total: entries.length },
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/run
// Execute a payroll run for a pay period. Status → COMPUTED.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/run",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(runPayrollSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: RunPayrollInput = {
        tenant_id: String(req.companyId!),
        pay_period_id: req.body.pay_period_id,
        run_description: req.body.run_description,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          return service.runPayroll(input);
        });
      });

      res.status(200).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/payroll/approve
// Approve a payroll run → auto-generates journal entry.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/approve",
  requireAuth,
  canManagePayroll,
  voucherRateLimiter,
  validate(approvePayrollSchema),
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: ApprovePayrollInput = {
        payroll_run_id: req.body.payroll_run_id,
        approved_by: req.body.approved_by,
      };

      const result = await withClient(async (conn) => {
        return withTransaction(conn, async (client: PoolClient) => {
          const service = new PayrollService(client);
          return service.approvePayroll(input, String(req.companyId!));
        });
      });

      res.status(200).json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/payroll/runs/:id
// Get a complete salary register for a payroll run.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/runs/:id",
  requireAuth,
  canManagePayroll,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid payroll run ID");

      const result = await withClient(async (conn) => {
        const service = new PayrollService(conn);
        return service.getSalaryRegister(id, String(req.companyId!));
      });

      res.json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/payroll/payslip/:employeeId/:payPeriodId
// Get an individual employee's payslip.
// ─────────────────────────────────────────────────────────────────────────

router.get(
  "/payslip/:employeeId/:payPeriodId",
  requireAuth,
  canManagePayroll,
  setSecurityContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const employeeId = parseInt(req.params.employeeId, 10);
      const payPeriodId = parseInt(req.params.payPeriodId, 10);

      if (isNaN(employeeId) || isNaN(payPeriodId)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid employee or period ID");
      }

      const result = await withClient(async (conn) => {
        const engine = new PayrollEngine(conn);

        // Load pay period for working days
        const { rows: ppRows } = await conn.query<{ working_days: number }>(
          `SELECT working_days FROM pay_periods WHERE pay_period_id = $1 AND tenant_id = $2`,
          [payPeriodId, String(req.companyId!)]
        );
        if (ppRows.length === 0) throw new AppError(ErrorCode.NOT_FOUND, "Pay period not found");

        return engine.computeEmployeePay(
          employeeId,
          payPeriodId,
          ppRows[0].working_days,
          String(req.companyId!)
        );
      });

      res.json({
        data: result,
        meta: { timestamp: new Date().toISOString(), trace_id: req.traceId, version: "1.0" },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

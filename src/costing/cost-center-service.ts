import { PoolClient } from "pg";
import {
  CreateCostCategoryInput,
  CreateCostCenterInput,
  CreateClassInput,
  AutoAllocationResult,
  CostCenterBreakupRow,
  CostCategoryBreakupRow,
  CostCenterTreeBreakupRow,
  CostCenterRow,
  CostCenterClassRow,
  CostCenterClassSplitRow,
} from "./costing-types";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// COST CENTER SERVICE — Allocation, Auto-Split, Validation, Reporting
// ---------------------------------------------------------------------------

export class CostCenterService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // COST CATEGORIES
  // -----------------------------------------------------------------------
  async createCategory(input: CreateCostCategoryInput, companyId: number): Promise<number> {
    const { rows } = await this.client.query<{ cost_category_id: number }>(
      `INSERT INTO cost_categories (company_id, category_name, description, is_mandatory)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, category_name) DO UPDATE SET is_active = TRUE
       RETURNING cost_category_id`,
      [companyId, input.category_name, input.description ?? null, input.is_mandatory ?? false]
    );
    return rows[0].cost_category_id;
  }

  // -----------------------------------------------------------------------
  // COST CENTERS
  // -----------------------------------------------------------------------
  async createCenter(input: CreateCostCenterInput, companyId: number): Promise<number> {
    // Build materialized path
    let path: string;

    if (input.parent_cost_center_id) {
      const { rows: parentRows } = await this.client.query<CostCenterRow>(
        `SELECT path FROM cost_centers WHERE cost_center_id = $1`,
        [input.parent_cost_center_id]
      );
      if (parentRows.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, "Parent cost center not found.");
      }
      path = parentRows[0].path + "." + input.parent_cost_center_id;
    } else {
      path = input.parent_cost_center_id ? "" : "";
    }

    const { rows } = await this.client.query<CostCenterRow>(
      `INSERT INTO cost_centers
         (company_id, cost_category_id, center_name, center_code,
          parent_cost_center_id, path)
       VALUES ($1, $2, $3, $4, $5, null)
       RETURNING cost_center_id, center_name`,
      [companyId, input.cost_category_id, input.center_name,
       input.center_code ?? null, input.parent_cost_center_id ?? null]
    );

    // Update path to include own ID after insert
    const ccId = rows[0].cost_center_id;
    const finalPath = input.parent_cost_center_id
      ? (await this.getPath(input.parent_cost_center_id)) + "." + ccId
      : String(ccId);

    await this.client.query(
      `UPDATE cost_centers SET path = $1::ltree WHERE cost_center_id = $2`,
      [finalPath, ccId]
    );

    return ccId;
  }

  // -----------------------------------------------------------------------
  // AUTO-ALLOCATION — Apply cost_center_class rules during voucher creation
  // -----------------------------------------------------------------------

  /**
   * Called AFTER journal_entries are inserted, BEFORE COMMIT.
   *
   * Flow:
   *   1. For each journal_entry_id, look up cost_center_classes by account_id.
   *   2. If a class exists, call auto_allocate_cost_centers() (SQL function).
   *   3. The function splits the entry amount using the stored percentages.
   *   4. The LAST split absorbs rounding error so total = 100% exactly.
   *   5. The DEFERRED constraint trigger validates at COMMIT.
   */
  async applyAutoAllocation(
    journalEntryIds: number[],
    companyId: number
  ): Promise<AutoAllocationResult[]> {
    const results: AutoAllocationResult[] = [];

    for (const jeId of journalEntryIds) {
      // Check if an auto-allocation class exists for this entry's account
      const { rows: classRows } = await this.client.query(
        `SELECT cc.class_id, cc.class_name
         FROM cost_center_classes cc
         JOIN journal_entries je ON je.account_id = cc.ledger_account_id
         WHERE je.entry_id = $1 AND cc.company_id = $2 AND cc.is_active = TRUE`,
        [jeId, companyId]
      );

      if (classRows.length === 0) {
        results.push({
          journal_entry_id: jeId,
          auto_applied: false,
          allocations: [],
        });
        continue;
      }

      // Call the SQL function to perform the split
      const { rows: allocRows } = await this.client.query<{
        allocation_id: number;
        cost_center_id: number;
        center_name: string;
        allocated_amount: string;
      }>(
        `SELECT cca.allocation_id, cca.cost_center_id,
                cc.center_name,
                cca.allocated_amount
         FROM auto_allocate_cost_centers($1, $2) AS alloc_id
         JOIN cost_center_allocations cca ON cca.allocation_id = alloc_id
         JOIN cost_centers cc ON cc.cost_center_id = cca.cost_center_id`,
        [jeId, companyId]
      );

      results.push({
        journal_entry_id: jeId,
        auto_applied: true,
        class_name: classRows[0].class_name,
        allocations: allocRows.map((r) => ({
          allocation_id: r.allocation_id,
          cost_center_id: r.cost_center_id,
          center_name: r.center_name,
          allocated_amount: Number(r.allocated_amount),
        })),
      });
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // MANUAL ALLOCATION — User chooses how to split a journal entry
  // -----------------------------------------------------------------------

  /**
   * Replaces all existing allocations for a journal_entry with a new set.
   * This ensures the 100% rule: sum of new allocations = journal entry amount.
   */
  async setAllocations(
    journalEntryId: number,
    companyId: number,
    allocations: Array<{ cost_center_id: number; allocated_amount: number }>
  ): Promise<void> {
    // 1. Validate total = journal entry amount
    const { rows: jeRows } = await this.client.query<{
      amount: string;
    }>(
      `SELECT COALESCE(debit_amount, 0) + COALESCE(credit_amount, 0) AS amount
       FROM journal_entries WHERE entry_id = $1`,
      [journalEntryId]
    );

    const entryAmount = Number(jeRows[0]?.amount ?? 0);
    const totalAlloc  = allocations.reduce((sum, a) => sum + a.allocated_amount, 0);

    if (Math.abs(entryAmount - totalAlloc) > 0.02) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Allocations sum (₹${totalAlloc.toFixed(2)}) must equal journal entry amount (₹${entryAmount.toFixed(2)}).`,
        { journal_entry_id: journalEntryId, entry_amount: entryAmount, allocation_sum: totalAlloc }
      );
    }

    // 2. Delete existing allocations (within same transaction)
    await this.client.query(
      `DELETE FROM cost_center_allocations WHERE journal_entry_id = $1`,
      [journalEntryId]
    );

    // 3. Insert new allocations
    for (const alloc of allocations) {
      if (alloc.allocated_amount <= 0) continue;
      await this.client.query(
        `INSERT INTO cost_center_allocations
           (company_id, journal_entry_id, cost_center_id, allocated_amount)
         VALUES ($1, $2, $3, $4)`,
        [companyId, journalEntryId, alloc.cost_center_id, alloc.allocated_amount]
      );
    }
  }

  // -----------------------------------------------------------------------
  // COST CENTER CLASSES — CRUD
  // -----------------------------------------------------------------------

  async createClass(input: CreateClassInput, companyId: number): Promise<number> {
    // Validate splits sum to 100%
    const totalPct = input.splits.reduce((s, sp) => s + sp.split_percentage, 0);
    if (Math.abs(totalPct - 100) > 0.01) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Split percentages must sum to 100%. Got ${totalPct}%.`
      );
    }

    // Insert class header
    const { rows: classRows } = await this.client.query<CostCenterClassRow>(
      `INSERT INTO cost_center_classes
         (company_id, class_name, ledger_account_id, description)
       VALUES ($1, $2, $3, $4)
       RETURNING class_id`,
      [companyId, input.class_name, input.ledger_account_id, input.description ?? null]
    );

    const classId = classRows[0].class_id;

    // Insert splits
    for (const split of input.splits) {
      await this.client.query(
        `INSERT INTO cost_center_class_splits
           (class_id, cost_center_id, split_percentage)
         VALUES ($1, $2, $3)`,
        [classId, split.cost_center_id, split.split_percentage]
      );
    }

    return classId;
  }

  // -----------------------------------------------------------------------
  // REPORTING
  // -----------------------------------------------------------------------

  /**
   * Cost Center Breakup — all expenses allocated to a single cost center
   * across a date range. Shows which ledger accounts incurred what.
   */
  async getCostCenterBreakup(
    costCenterId: number,
    fromDate: string,
    toDate: string
  ): Promise<{ cost_center_name: string; period: { from: string; to: string }; rows: CostCenterBreakupRow[] }> {
    const { rows: nameRows } = await this.client.query<{ center_name: string }>(
      `SELECT center_name FROM cost_centers WHERE cost_center_id = $1`,
      [costCenterId]
    );

    const { rows } = await this.client.query(
      `SELECT * FROM get_cost_center_breakup($1, $2, $3)`,
      [costCenterId, fromDate, toDate]
    );

    return {
      cost_center_name: nameRows[0]?.center_name ?? "Unknown",
      period: { from: fromDate, to: toDate },
      rows: rows as unknown as CostCenterBreakupRow[],
    };
  }

  /**
   * Category Breakup — all centers under a category, grouped by center + ledger.
   */
  async getCostCategoryBreakup(
    costCategoryId: number,
    fromDate: string,
    toDate: string
  ): Promise<CostCategoryBreakupRow[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM get_cost_category_breakup($1, $2, $3)`,
      [costCategoryId, fromDate, toDate]
    );
    return rows as unknown as CostCategoryBreakupRow[];
  }

  /**
   * Tree Breakup — hierarchical drill-down: parent + all child cost centers.
   * Uses ltree <@ for fast subtree aggregation.
   */
  async getCostCenterTreeBreakup(
    parentCostCenterId: number,
    fromDate: string,
    toDate: string
  ): Promise<CostCenterTreeBreakupRow[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM get_cost_center_tree_breakup($1, $2, $3)`,
      [parentCostCenterId, fromDate, toDate]
    );
    return rows as unknown as CostCenterTreeBreakupRow[];
  }

  // -----------------------------------------------------------------------
  // HELPERS
  // -----------------------------------------------------------------------
  private async getPath(costCenterId: number): Promise<string> {
    const { rows } = await this.client.query<CostCenterRow>(
      `SELECT path::TEXT AS path FROM cost_centers WHERE cost_center_id = $1`,
      [costCenterId]
    );
    return rows[0]?.path ?? "";
  }
}

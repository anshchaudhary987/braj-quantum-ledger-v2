export interface CostCategoryRow {
  cost_category_id: number;
  company_id: number;
  category_name: string;
  description: string | null;
  is_mandatory: boolean;
  is_active: boolean;
}

export interface CostCenterRow {
  cost_center_id: number;
  company_id: number;
  cost_category_id: number;
  center_name: string;
  center_code: string | null;
  parent_cost_center_id: number | null;
  path: string;
  is_active: boolean;
}

export interface CostCenterAllocationRow {
  allocation_id: number;
  company_id: number;
  journal_entry_id: number;
  cost_center_id: number;
  allocated_amount: string;
}

export interface CostCenterClassRow {
  class_id: number;
  company_id: number;
  class_name: string;
  ledger_account_id: number;
  description: string | null;
  is_active: boolean;
}

export interface CostCenterClassSplitRow {
  split_id: number;
  class_id: number;
  cost_center_id: number;
  split_percentage: string;
}

// ---------- API Input / Output types ----------

export interface CreateCostCategoryInput {
  category_name: string;
  description?: string;
  is_mandatory?: boolean;
}

export interface CreateCostCenterInput {
  cost_category_id: number;
  center_name: string;
  center_code?: string;
  parent_cost_center_id?: number;
}

export interface CreateClassInput {
  class_name: string;
  ledger_account_id: number;
  description?: string;
  splits: Array<{
    cost_center_id: number;
    split_percentage: number;
  }>;
}

export interface AutoAllocationResult {
  journal_entry_id: number;
  auto_applied: boolean;
  class_name?: string;
  allocations: Array<{
    allocation_id: number;
    cost_center_id: number;
    center_name: string;
    allocated_amount: number;
  }>;
}

export interface CostCenterBreakupRow {
  ledger_account_name: string;
  ledger_account_code: string;
  total_allocated: number;
  transaction_count: number;
  first_txn_date: string;
  last_txn_date: string;
}

export interface CostCategoryBreakupRow {
  cost_center_name: string;
  ledger_account_name: string;
  total_allocated: number;
}

export interface CostCenterTreeBreakupRow {
  cost_center_name: string;
  depth: number;
  ledger_account_name: string;
  total_allocated: number;
}

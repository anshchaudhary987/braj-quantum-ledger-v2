export interface BomRow {
  bom_id: number;
  company_id: number;
  bom_name: string;
  bom_code: string | null;
  finished_good_item_id: number;
  base_output_quantity: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface BomItemRow {
  bom_item_id: number;
  bom_id: number;
  stock_item_id: number;
  item_type: "RAW_MATERIAL" | "BY_PRODUCT" | "CO_PRODUCT";
  required_quantity: string;
  uom_id: number;
  scrap_percentage: string;
  sort_order: number;
}

export interface MfgJournalRow {
  mfg_journal_id: number;
  company_id: number;
  transaction_id: number;
  bom_id: number;
  finished_good_item_id: number;
  quantity_produced: string;
  godown_id: number;
  production_date: string;
  total_raw_material_cost: string;
  total_overhead_cost: string;
  total_by_product_value: string;
  total_fg_cost: string;
  unit_cost: string;
}

export interface MfgJournalItemRow {
  mfg_journal_item_id: number;
  mfg_journal_id: number;
  stock_item_id: number;
  item_type: string;
  quantity: string;
  uom_id: number;
  rate: string;
  total_amount: string;
  stock_txn_id: number | null;
}

export interface MfgOverheadRow {
  overhead_id: number;
  mfg_journal_id: number;
  cost_type: string;
  cost_description: string | null;
  cost_amount: string;
  allocation_method: "PER_UNIT" | "FIXED_TOTAL" | "PERCENTAGE_OF_MATERIAL";
  allocation_percentage: string | null;
}

// ---------- API Inputs ----------

export interface CreateBomInput {
  bom_name: string;
  bom_code?: string;
  finished_good_item_id: number;
  base_output_quantity?: number;
  effective_from?: string;
  items: Array<{
    stock_item_id: number;
    item_type: "RAW_MATERIAL" | "BY_PRODUCT" | "CO_PRODUCT";
    required_quantity: number;
    uom_id: number;
    scrap_percentage?: number;
    sort_order?: number;
  }>;
}

export interface ProcessManufacturingInput {
  bom_id: number;
  quantity_produced: number;
  godown_id: number;
  production_date: string;
  narration?: string;
  overhead_costs: Array<{
    cost_type: string;
    cost_description?: string;
    cost_amount: number;
    allocation_method: "PER_UNIT" | "FIXED_TOTAL" | "PERCENTAGE_OF_MATERIAL";
    allocation_percentage?: number;
  }>;
  idempotency_key: string;
}

export interface MfgProcessResult {
  transaction_id: number;
  mfg_journal_id: number;
  cost_summary: {
    raw_material_cost: number;
    overhead_cost: number;
    by_product_value: number;
    total_fg_cost: number;
    unit_cost: number;
  };
  stock_movements: Array<{
    stock_txn_id: number;
    item_id: number;
    item_name: string;
    item_type: string;
    quantity: number;
    direction: "IN" | "OUT";
  }>;
}
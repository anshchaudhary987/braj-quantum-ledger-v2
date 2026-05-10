export interface UomRow {
  uom_id: number;
  uom_name: string;
  symbol: string;
  base_uom_id: number | null;
  conversion_factor: string; // NUMERIC
  formal_name: string | null;
}

export interface StockItemRow {
  stock_item_id: number;
  stock_category_id: number;
  item_name: string;
  item_code: string;
  base_uom_id: number;
  purchase_uom_id: number | null;
  sales_uom_id: number | null;
  valuation_method: "FIFO" | "WEIGHTED_AVERAGE";
  opening_quantity: string;
  opening_rate: string;
  opening_value: string;
  stock_ledger_account_id: number | null;
  is_tracked_by_batch: boolean;
  is_tracked_by_serial: boolean;
  is_active: boolean;
}

export interface GodownRow {
  godown_id: number;
  godown_name: string;
  godown_code: string;
}

export interface StockTransactionRow {
  stock_txn_id: number;
  transaction_id: number;
  journal_entry_id: number | null;
  transaction_type: string;
  item_id: number;
  godown_id: number;
  quantity_in: string;
  quantity_out: string;
  rate: string;
  amount: string;
  uom_id: number;
  uom_quantity: string;
  narration: string | null;
  created_at: string;
}

export interface StockLayerRow {
  layer_id: number;
  stock_item_id: number;
  godown_id: number;
  batch_id: number | null;
  remaining_quantity: string;
  rate: string;
  purchase_date: string;
  is_exhausted: boolean;
}

export interface StockValuationRow {
  stock_item_id: number;
  godown_id: number;
  valuation_method: string;
  current_wac: string | null;
  total_quantity: string;
  total_value: string;
}

export interface BatchRow {
  batch_id: number;
  stock_item_id: number;
  batch_number: string;
  manufacturing_date: string | null;
  expiry_date: string | null;
  mrp: string | null;
}

export interface SerialRow {
  serial_id: number;
  stock_item_id: number;
  serial_number: string;
  batch_id: number | null;
  status: "IN_STOCK" | "SOLD" | "TRANSFERRED" | "DAMAGED" | "RETURNED" | "EXPIRED";
  godown_id: number;
}

// ---------- Request / Input types ----------

export interface CreateStockMovementInput {
  transaction_type: string;
  item_id: number;
  godown_id: number;
  quantity: number;         // in the user-supplied UOM
  uom_id: number;           // the UOM the user is using
  rate: number;             // per base UOM
  amount: number;
  narration?: string;
  batch_allocations?: { batch_id: number; quantity: number }[];
  serial_numbers?: number[];
  reference_type?: string;
  reference_id?: string;
}

export interface StockMovementResult {
  stock_txn_id: number;
  transaction_id: number;
  quantity_in_base: number;
  valuation_impact: {
    method: string;
    wac_before: number | null;
    wac_after: number | null;
    layers_consumed: number;
    cogs: number;
  };
}

export interface FifoConsumption {
  layer_id: number;
  quantity_consumed: number;
  rate: number;
  cost: number;
}

export interface UomConversionResult {
  base_quantity: number;
  base_uom_id: number;
  base_symbol: string;
  from_symbol: string;
}

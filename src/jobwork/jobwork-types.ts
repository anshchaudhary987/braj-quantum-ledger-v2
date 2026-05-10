export type ChallanType = "JOB_WORK_OUT" | "JOB_WORK_IN";

export type ChallanStatus = "DRAFT" | "SENT" | "PARTIALLY_RECEIVED" | "COMPLETED" | "CANCELLED";

export type ChallanItemType = "RAW_MATERIAL" | "FINISHED_GOOD" | "SCRAP" | "BY_PRODUCT" | "PACKING" | "CONSUMABLE";

// ---------- Row types ----------

export interface DeliveryChallanRow {
  challan_id: number;
  company_id: number;
  challan_type: ChallanType;
  challan_number: string;
  challan_date: string;
  vendor_account_id: number;
  vendor_godown_id: number;
  reference_challan_id: number | null;
  status: ChallanStatus;
  is_accounted: boolean;
  service_transaction_id: number | null;
  narration: string | null;
}

export interface DeliveryChallanItemRow {
  challan_item_id: number;
  challan_id: number;
  stock_item_id: number;
  item_type: ChallanItemType;
  quantity: string;
  uom_id: number;
  received_quantity: string;
  rate: string;
  send_stock_txn_id: number | null;
  receive_stock_txn_id: number | null;
  expected_scrap_pct: string | null;
  actual_scrap_quantity: string | null;
  narration: string | null;
}

export interface JobWorkYieldRow {
  stock_item_id: number;
  item_name: string;
  item_type: string;
  quantity_sent: number;
  quantity_received: number;
  quantity_pending: number;
  scrap_generated: number;
  yield_pct: number;
}

export interface VendorStockRow {
  godown_id: number;
  godown_name: string;
  vendor_name: string;
  stock_item_id: number;
  item_name: string;
  quantity_with_vendor: number;
  value_with_vendor: number;
  current_wac: number | null;
}

// ---------- API Inputs ----------

export interface CreateJobWorkOutChallanInput {
  challan_number: string;
  challan_date: string;
  vendor_account_id: number;
  narration?: string;
  items: Array<{
    stock_item_id: number;
    item_type: ChallanItemType;
    quantity: number;
    uom_id: number;
    rate?: number;
    expected_scrap_pct?: number;
    narration?: string;
  }>;
}

export interface CreateJobWorkInChallanInput {
  challan_number: string;
  challan_date: string;
  vendor_account_id: number;
  reference_challan_id: number;            // links back to JOB_WORK_OUT
  narration?: string;
  items: Array<{
    stock_item_id: number;
    item_type: ChallanItemType;
    quantity: number;
    uom_id: number;
    rate?: number;
    actual_scrap_quantity?: number;
    narration?: string;
  }>;
}

export interface LinkServiceInvoiceInput {
  challan_id: number;
  service_transaction_id: number;         // the vendor's labour invoice
  idempotency_key: string;
}

export interface JobWorkValuationResult {
  raw_material_cost: number;
  service_charges: number;
  scrap_value: number;
  fg_total_cost: number;
  fg_unit_cost: number;
}

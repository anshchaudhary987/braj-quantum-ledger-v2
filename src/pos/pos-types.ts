// ============================================================================
// POS TYPE DEFINITIONS
// ============================================================================

export interface POSTenderType {
  tender_type_id: number;
  tender_code: string;
  tender_name: string;
  gl_account_id: number;
  settlement_days: number;
  is_active: boolean;
}

export interface POSTenderPayment {
  tender_type_id: number;
  tender_code: string;
  tender_name: string;
  amount: number;
  reference_no?: string;
  authorization_code?: string;
  terminal_id?: string;
  card_type?: string;
}

export interface POSLineItem {
  barcode?: string;
  stock_item_id: number;
  item_name: string;
  hsn_code?: string;
  uom_id: number;
  uom_quantity: number;
  base_quantity: number;
  rate: number;
  discount_percent: number;
  discount_amount: number;
  taxable_value: number;
  gst_rate: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  cess_amount: number;
  line_total: number;
}

export interface CreatePOSInvoiceInput {
  company_id: number;
  cashier_user_id: number;
  counter_id?: string;
  customer_account_id?: number;
  customer_name?: string;
  customer_phone?: string;
  items: POSLineItem[];
  tenders: POSTenderPayment[];
  narration?: string;
}

export interface POSInvoice {
  pos_invoice_id: number;
  invoice_no: string;
  invoice_date: string;
  invoice_time: string;
  counter_id: string;
  cashier_user_id: number;
  customer_account_id: number | null;
  customer_name: string | null;
  item_count: number;
  subtotal: number;
  discount_amount: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  cess_amount: number;
  round_off: number;
  grand_total: number;
  total_tendered: number;
  change_returned: number;
  transaction_id: number;
  status: string;
  tenders: POSTenderPayment[];
  items: POSLineItem[];
}

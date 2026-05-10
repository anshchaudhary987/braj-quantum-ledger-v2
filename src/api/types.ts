// ============================================================================
// AUTH TYPES
// ============================================================================

export interface LoginRequest {
  email: string;
  password: string;
  company_id?: number;       // if user belongs to multiple companies
  device_info?: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;        // seconds until access token expires
  user: UserProfile;
  companies: CompanyBrief[]; // all companies this user can access
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;     // rotated — old one invalidated
  expires_in: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  company_name: string;
  company_type?: string;
  registration_no?: string;
}

export interface RegisterResponse extends LoginResponse {
  message: string;
  user_id: number;
  company_id: number;
}

export interface UserProfile {
  user_id: number;
  email: string;
  name: string;
  current_company_id: number;
  current_company_name: string;
  roles: string[];
}

export interface CompanyBrief {
  company_id: number;
  company_name: string;
  gstin?: string;
}

// ============================================================================
// JWT PAYLOAD
// ============================================================================

export interface JwtPayload {
  sub: number;               // user_id
  cid: number;               // company_id
  roles: string[];
  iat: number;
  exp: number;
  jti: string;               // unique token ID
}

// ============================================================================
// SALES VOUCHER TYPES
// ============================================================================

export interface SalesVoucherHeader {
  voucher_date: string;              // YYYY-MM-DD
  customer_account_id: number;
  reference_number?: string;         // invoice/order number
  place_of_supply_state: string;     // state code
  narration?: string;
  metadata?: Record<string, unknown>;
}

export interface SalesLineItem {
  stock_item_id: number;
  description?: string;
  quantity: number;
  uom_id: number;
  rate: number;
  discount_percent?: number;
  discount_amount?: number;
  hsn_sac_code: string;
  godown_id: number;
  batch_id?: number;
  serial_numbers?: number[];         // for serial-tracked items
}

export interface SalesVoucherTaxDetails {
  counterparty_gstin?: string;
  is_rcm_applicable?: boolean;
}

export interface SalesVoucherRequest {
  header: SalesVoucherHeader;
  line_items: SalesLineItem[];
  tax_details: SalesVoucherTaxDetails;
  idempotency_key: string;
}

export interface SalesVoucherLineResponse {
  line_number: number;
  stock_item_id: number;
  item_name: string;
  quantity: number;
  rate: number;
  amount: number;
  discount_amount: number;
  taxable_value: number;
  tax_components: Array<{
    component: string;
    rate: number;
    amount: number;
  }>;
}

export interface SalesVoucherResponse {
  transaction_id: number;
  voucher_number: string;
  voucher_date: string;
  customer_name: string;
  line_items: SalesVoucherLineResponse[];
  totals: {
    gross_amount: number;
    total_discount: number;
    taxable_value: number;
    total_tax: number;
    grand_total: number;
  };
  tax_summary: Array<{
    component: string;
    rate: number;
    taxable_value: number;
    tax_amount: number;
  }>;
  stock_movements: Array<{
    stock_txn_id: number;
    item_name: string;
    quantity_out: number;
  }>;
}

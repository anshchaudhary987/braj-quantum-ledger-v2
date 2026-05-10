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

export interface LoginRequest {
  email: string;
  password: string;
  company_id?: number;
  device_info?: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: UserProfile;
  companies: CompanyBrief[];
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface SalesVoucherHeader {
  voucher_date: string;
  customer_account_id: number;
  reference_number?: string;
  place_of_supply_state: string;
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
  serial_numbers?: number[];
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

export interface ApiResponse<T> {
  data: T;
  meta: {
    timestamp: string;
    trace_id: string;
    version: string;
  };
}

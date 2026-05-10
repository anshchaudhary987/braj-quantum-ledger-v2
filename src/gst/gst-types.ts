export interface HsnSacRow {
  hsn_sac_id: number;
  code: string;
  description: string;
  code_type: "HSN" | "SAC";
  igst_rate: string;
  cess_rate: string;
  cess_name: string | null;
  effective_from: string;
  effective_to: string | null;
}

export interface GstRegistrationRow {
  gst_registration_id: number;
  account_id: number;
  gstin: string;
  legal_name: string;
  trade_name: string | null;
  registration_type: string;
  state_code: string;
  pan: string | null;
  filing_frequency: string;
}

export interface StateMasterRow {
  state_code: string;
  state_name: string;
  region_type: "STATE" | "UNION_TERRITORY";
  has_own_legislature: boolean;
}

export interface TaxEntryRow {
  tax_entry_id: number;
  transaction_id: number;
  journal_entry_id: number;
  counterparty_gstin: string | null;
  tax_type: "INPUT" | "OUTPUT";
  component: "CGST" | "SGST" | "UTGST" | "IGST" | "CESS";
  hsn_sac_id: number | null;
  hsn_sac_code: string | null;
  taxable_value: string;
  tax_rate: string;
  tax_amount: string;
  place_of_supply_state_code: string;
  is_rcm: boolean;
  rcm_reason: string | null;
  return_period: string | null;
  narration: string | null;
}

// ---------- Request / Result types ----------

export interface TaxCalculationInput {
  transaction_id: number;
  tax_type: "INPUT" | "OUTPUT";
  company_gstin: string;
  counterparty_gstin?: string;
  hsn_sac_code: string;
  taxable_value: number;
  place_of_supply_state_code: string;
  is_rcm_applicable?: boolean;
  rcm_reason?: string;
}

export interface TaxComponent {
  component: "CGST" | "SGST" | "UTGST" | "IGST" | "CESS";
  tax_rate: number;
  tax_amount: number;
}

export interface TaxCalculationResult {
  tax_type: "INPUT" | "OUTPUT";
  taxable_value: number;
  hsn_sac_code: string;
  igst_rate: number;
  cess_rate: number;
  is_interstate: boolean;
  place_of_supply_state: string;
  company_state: string;
  components: TaxComponent[];
  total_tax: number;
  total_invoice_value: number;
  is_rcm: boolean;
  is_utgst_applicable: boolean;
}

export interface GstinValidationResult {
  isValid: boolean;
  gstin: string;
  stateCode: string | null;
  pan: string | null;
  errorMessage?: string;
}

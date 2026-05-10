// ============================================================================
// TALLY XML → PostgreSQL MIGRATION ENGINE — TypeScript Types
// ============================================================================

// ── ENUMS ──────────────────────────────────────────────────────────────────

export type TallyImportStatus =
  | "UPLOADED"
  | "PARSING"
  | "MASTERS_IMPORTED"
  | "VOUCHERS_IMPORTING"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "FAILED"
  | "ROLLED_BACK";

export type TallyMasterType = "LEDGER" | "GROUP";

// ── TALLY XML NODE TYPES (as parsed by SAX parser) ────────────────────────

export interface TallyLedger {
  GUID: string;
  NAME: string;
  PARENT: string;
  OPENINGBALANCE: number;
  ISBILLWISEON?: string;
  ISCOSTCENTRESON?: string;
  GSTIN?: string;
  MAILINGNAME?: string;
  ADDRESS?: string;
  PINCODE?: string;
  LEDGERPHONE?: string;
}

export interface TallyGroup {
  GUID: string;
  NAME: string;
  PARENT: string;
  ISSUBLEDGER?: string;
  GROUPLIST?: string;
}

export interface TallyAllLedgerEntry {
  LEDGERNAME: string;
  ISDEEMEDPOSITIVE: "Yes" | "No";
  AMOUNT: number;
  BILLALLOCATIONS?: {
    NAME: string;
    AMOUNT: number;
    BILLTYPE: string;
  }[];
}

export interface TallyVoucher {
  VOUCHERTYPENAME: string;
  VOUCHERNUMBER: string;
  GUID: string;
  DATE: string;                // DD-MMM-YYYY format
  NARRATION: string;
  EFFECTIVEDATE?: string;
  VOUCHERKEY?: string;
  REFERENCE?: string;
  ALLLEDGERENTRIES: {
    LIST: TallyAllLedgerEntry[];
  };
  INVENTORYENTRIES?: unknown;
}

// ── DATABASE ROW TYPES ─────────────────────────────────────────────────────

export interface TallyImportBatchRow {
  import_batch_id: string;
  tenant_id: string;
  original_filename: string;
  s3_key: string | null;
  file_size_bytes: string | null;
  tally_version: string | null;
  company_name_in_tally: string | null;
  import_status: TallyImportStatus;
  status_history: StatusHistoryEntry[];
  error_message: string | null;
  total_groups: number;
  total_ledgers: number;
  masters_imported: number;
  masters_skipped: number;
  total_vouchers: number;
  vouchers_imported: number;
  vouchers_failed: number;
  vouchers_skipped: number;
  current_batch_num: number;
  total_batches: number;
  parsing_started_at: string | null;
  parsing_completed_at: string | null;
  masters_started_at: string | null;
  masters_completed_at: string | null;
  vouchers_started_at: string | null;
  vouchers_completed_at: string | null;
  total_duration_ms: number | null;
  tally_grand_total_debit: string | null;
  imported_grand_total_debit: string | null;
  tally_grand_total_credit: string | null;
  imported_grand_total_credit: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TallyMasterMappingRow {
  mapping_id: number;
  tenant_id: string;
  import_batch_id: string;
  tally_guid: string | null;
  tally_name: string;
  tally_parent_name: string | null;
  tally_master_type: TallyMasterType;
  tally_opening_balance: string;
  mapped_account_id: number | null;
  is_system_default: boolean;
  created_at: string;
}

export interface TallyImportErrorRow {
  error_id: number;
  import_batch_id: string;
  batch_number: number;
  voucher_index: number | null;
  tally_voucher_key: string | null;
  tally_voucher_type: string | null;
  tally_voucher_date: string | null;
  error_code: string;
  error_message: string;
  raw_xml_fragment: string | null;
  created_at: string;
}

export interface StatusHistoryEntry {
  status: string;
  timestamp: string;
  actor: string;
}

// ── IMPORT ENGINE TYPES ────────────────────────────────────────────────────

export interface TallyImportOptions {
  tenant_id: string;
  import_batch_id: string;
  s3_key: string;
  batch_size?: number;          // vouchers per DB transaction (default 500)
  skip_duplicate_vouchers?: boolean;
  uploaded_by?: string;
}

export interface Phase1Result {
  groups_imported: number;
  groups_skipped: number;
  ledgers_imported: number;
  ledgers_skipped: number;
  duration_ms: number;
}

export interface Phase2Result {
  total_vouchers: number;
  vouchers_imported: number;
  vouchers_failed: number;
  vouchers_skipped: number;
  batches_processed: number;
  duration_ms: number;
}

export interface TallyImportResult {
  import_batch_id: string;
  status: TallyImportStatus;
  phase1: Phase1Result;
  phase2: Phase2Result;
  total_duration_ms: number;
}

export interface VerificationResult {
  import_batch_id: string;
  summary: Array<{
    section: string;
    tally_amount: number;
    imported_amount: number;
    difference: number;
    status: string;
  }>;
  overall_match: boolean;
}

// ── VOUCHER TYPE MAPPING ───────────────────────────────────────────────────

/**
 * Tally Voucher Types → Internal voucher_type strings
 *
 * Sales, Credit Note, Receipt, Contra, Payment → map to our existing strategies
 * Others use TALLY_IMPORTED as a catch-all
 */
export const TALLY_VOUCHER_TYPE_MAP: Record<string, string> = {
  "Sales":           "SALES_VOUCHER",
  "Credit Note":     "SALES_VOUCHER",      // treated as negative sales
  "Purchase":        "PURCHASE_VOUCHER",    // map to purchase voucher
  "Debit Note":      "PURCHASE_VOUCHER",    // treated as negative purchase
  "Receipt":         "RECEIPT_VOUCHER",
  "Payment":         "PAYMENT_VOUCHER",
  "Contra":          "CONTRA_VOUCHER",
  "Journal":         "JOURNAL_VOUCHER",
  "Purchase Order":  "TALLY_IMPORTED",      // not a financial entry, skip
  "Sales Order":     "TALLY_IMPORTED",
  "Delivery Note":   "TALLY_IMPORTED",
  "Receipt Note":    "TALLY_IMPORTED",
  "Reversing Journal":"JOURNAL_VOUCHER",
  "Memorandum":      "TALLY_IMPORTED",
  "Payroll":         "SALARY_VOUCHER",
};

// ── SAX PARSER EVENTS ──────────────────────────────────────────────────────

export interface SaxEvent {
  type: "opentag" | "closetag" | "text" | "cdata" | "error" | "end";
  name?: string;
  text?: string;
  error?: Error;
}

// ── PARSED XML STRUCTURE (in-memory node during streaming) ─────────────────

export interface TallyXmlNode {
  name: string;
  text: string;
  children: Map<string, TallyXmlNode | TallyXmlNode[]>;
  attributes: Record<string, string>;
}

export interface TallyEnvelope {
  company_name: string;
  tally_version: string;
  export_date: string;
  ledgers: TallyLedger[];
  groups: TallyGroup[];
  vouchers: TallyVoucher[];
}

// ── API INPUT TYPES ────────────────────────────────────────────────────────

export interface StartTallyImportInput {
  tenant_id: string;
  original_filename: string;
  s3_key: string;
  file_size_bytes?: number;
  batch_size?: number;
  uploaded_by?: string;
}

export interface RetryFailedVouchersInput {
  import_batch_id: string;
  tenant_id: string;
}

export interface GetImportStatusInput {
  import_batch_id: string;
  tenant_id: string;
}
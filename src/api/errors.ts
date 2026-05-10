// ============================================================================
// API ERROR CODES — Accounting-specific, machine-readable, audit-friendly
// ============================================================================

export enum ErrorCode {
  // Authentication & Authorization
  UNAUTHORIZED          = "UNAUTHORIZED",
  FORBIDDEN             = "FORBIDDEN",
  TOKEN_EXPIRED         = "TOKEN_EXPIRED",
  TOKEN_REVOKED         = "TOKEN_REVOKED",
  INVALID_CREDENTIALS   = "INVALID_CREDENTIALS",

  // Validation
  VALIDATION_ERROR      = "VALIDATION_ERROR",
  INVALID_GSTIN         = "INVALID_GSTIN",
  INVALID_PLACE_OF_SUPPLY = "INVALID_PLACE_OF_SUPPLY",
  INVALID_HSN_SAC       = "INVALID_HSN_SAC",

  // Accounting
  DOUBLE_ENTRY_VIOLATION = "DOUBLE_ENTRY_VIOLATION",
  LEDGER_LOCKED          = "LEDGER_LOCKED",
  PERIOD_CLOSED          = "PERIOD_CLOSED",
  ACCOUNT_NOT_FOUND      = "ACCOUNT_NOT_FOUND",
  TRANSACTION_NOT_FOUND  = "TRANSACTION_NOT_FOUND",

  // Inventory
  INSUFFICIENT_STOCK     = "INSUFFICIENT_STOCK",
  ITEM_NOT_FOUND         = "ITEM_NOT_FOUND",
  GODOWN_NOT_FOUND       = "GODOWN_NOT_FOUND",
  BATCH_EXPIRED          = "BATCH_EXPIRED",

  // GST
  GST_RATE_NOT_FOUND     = "GST_RATE_NOT_FOUND",
  TAX_MISMATCH           = "TAX_MISMATCH",

  // Idempotency
  IDEMPOTENCY_CONFLICT   = "IDEMPOTENCY_CONFLICT",

  // E-Invoicing & E-Way Bill
  EINVOICE_NOT_FOUND       = "EINVOICE_NOT_FOUND",
  EINVOICE_ALREADY_GENERATED = "EINVOICE_ALREADY_GENERATED",
  EINVOICE_CANCEL_WINDOW_EXPIRED = "EINVOICE_CANCEL_WINDOW_EXPIRED",
  EINVOICE_IRP_ERROR       = "EINVOICE_IRP_ERROR",
  EINVOICE_GSP_AUTH_FAILED = "EINVOICE_GSP_AUTH_FAILED",
  EINVOICE_INVALID_STATE   = "EINVOICE_INVALID_STATE",
  EWAY_BILL_NOT_FOUND      = "EWAY_BILL_NOT_FOUND",
  EWAY_BILL_DISTANCE_REQUIRED = "EWAY_BILL_DISTANCE_REQUIRED",
  EWAY_BILL_NIC_ERROR      = "EWAY_BILL_NIC_ERROR",
  GSP_CREDENTIAL_NOT_FOUND = "GSP_CREDENTIAL_NOT_FOUND",
  RETRY_QUEUED             = "RETRY_QUEUED",

  // Payroll & HRMS
  EMPLOYEE_NOT_FOUND         = "EMPLOYEE_NOT_FOUND",
  DUPLICATE_EMPLOYEE_CODE    = "DUPLICATE_EMPLOYEE_CODE",
  PAY_PERIOD_NOT_FOUND       = "PAY_PERIOD_NOT_FOUND",
  PAY_PERIOD_CLOSED          = "PAY_PERIOD_CLOSED",
  PAYROLL_RUN_NOT_FOUND      = "PAYROLL_RUN_NOT_FOUND",
  PAYROLL_ALREADY_APPROVED   = "PAYROLL_ALREADY_APPROVED",
  INVALID_PAYROLL_STATE      = "INVALID_PAYROLL_STATE",
  SALARY_STRUCTURE_NOT_FOUND = "SALARY_STRUCTURE_NOT_FOUND",
  INSUFFICIENT_ATTENDANCE_DATA = "INSUFFICIENT_ATTENDANCE_DATA",

  // OCR & Document AI
  DOCUMENT_NOT_FOUND           = "DOCUMENT_NOT_FOUND",
  OCR_EXTRACTION_FAILED        = "OCR_EXTRACTION_FAILED",
  OCR_LOW_CONFIDENCE           = "OCR_LOW_CONFIDENCE",
  OCR_VENDOR_NOT_MATCHED       = "OCR_VENDOR_NOT_MATCHED",
  OCR_LEDGER_NOT_CLASSIFIED    = "OCR_LEDGER_NOT_CLASSIFIED",
  DUPLICATE_DOCUMENT           = "DUPLICATE_DOCUMENT",
  UNSUPPORTED_DOCUMENT_FORMAT  = "UNSUPPORTED_DOCUMENT_FORMAT",
  VOUCHER_ALREADY_APPROVED     = "VOUCHER_ALREADY_APPROVED",

  // Tally Import & Migration
  TALLY_IMPORT_FAILED          = "TALLY_IMPORT_FAILED",
  TALLY_XML_PARSE_ERROR        = "TALLY_XML_PARSE_ERROR",
  TALLY_MASTER_MAPPING_FAILED  = "TALLY_MASTER_MAPPING_FAILED",
  TALLY_VOUCHER_MAPPING_FAILED = "TALLY_VOUCHER_MAPPING_FAILED",
  TALLY_BATCH_NOT_FOUND        = "TALLY_BATCH_NOT_FOUND",
  TALLY_IMPORT_IN_PROGRESS     = "TALLY_IMPORT_IN_PROGRESS",
  TALLY_VERIFICATION_MISMATCH  = "TALLY_VERIFICATION_MISMATCH",

  // Rate Limiting
  RATE_LIMIT_EXCEEDED    = "RATE_LIMIT_EXCEEDED",

  // General
  INTERNAL_ERROR         = "INTERNAL_ERROR",
  NOT_FOUND              = "NOT_FOUND",
  CONFLICT               = "CONFLICT",
}

// ============================================================================
// STANDARD ERROR RESPONSE
// ============================================================================

export interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    trace_id: string;
    timestamp: string;
  };
}

// ============================================================================
// PAGINATION
// ============================================================================

export interface PaginationParams {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    has_next: boolean;
    has_prev: boolean;
    next_cursor?: string;
  };
}

// ============================================================================
// STANDARD SUCCESS RESPONSE
// ============================================================================

export interface ApiSuccessResponse<T> {
  data: T;
  meta?: {
    timestamp: string;
    trace_id: string;
    version: string;
  };
}
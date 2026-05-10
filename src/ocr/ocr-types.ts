// ============================================================================
// AI DOCUMENT OCR PIPELINE — TypeScript Type Definitions
// ============================================================================

// ── ENUMS ──────────────────────────────────────────────────────────────────

export type DocumentStatus =
  | "UPLOADED"
  | "QUEUED"
  | "OCR_IN_PROGRESS"
  | "OCR_COMPLETED"
  | "LLM_PARSING"
  | "EXTRACTION_DONE"
  | "MATCHING"
  | "DRAFT_READY"
  | "APPROVED"
  | "REJECTED"
  | "FAILED";

export type DocEntityType =
  | "PURCHASE_INVOICE"
  | "EXPENSE_RECEIPT"
  | "CREDIT_NOTE"
  | "DEBIT_NOTE"
  | "BANK_STATEMENT"
  | "OTHER";

export type ReviewDecision =
  | "PENDING_REVIEW"
  | "AUTO_APPROVED"
  | "FLAGGED"
  | "AMENDED"
  | "APPROVED"
  | "REJECTED";

export type OcrProvider = "AWS_TEXTRACT" | "GOOGLE_DOC_AI" | "TESSERACT";

export type LlmModel = "claude-3-opus" | "claude-3-sonnet" | "gpt-4o" | "gpt-4-turbo" | "llama-3-70b";

// ── DATABASE ROW TYPES ─────────────────────────────────────────────────────

export interface UploadedDocumentRow {
  document_id: number;
  tenant_id: string;
  original_filename: string;
  s3_bucket: string;
  s3_key: string;
  s3_url: string;
  file_size_bytes: string | null;
  mime_type: string | null;
  page_count: number;
  file_hash_sha256: string | null;
  entity_type: DocEntityType;
  upload_status: DocumentStatus;
  status_history: StatusHistoryEntry[];
  error_message: string | null;
  ocr_provider: string | null;
  ocr_job_id: string | null;
  ocr_started_at: string | null;
  ocr_completed_at: string | null;
  ocr_tokens_used: number;
  ocr_cost_estimate: string | null;
  processing_time_ms: number | null;
  uploaded_by: string | null;
  uploaded_at: string;
  created_at: string;
  updated_at: string;
}

export interface OcrRawResultRow {
  raw_result_id: number;
  document_id: number;
  page_number: number;
  raw_text: string;
  text_blocks: Record<string, unknown> | null;
  table_blocks: Record<string, unknown> | null;
  provider_response: Record<string, unknown> | null;
  created_at: string;
}

export interface OcrExtractionResultRow {
  extraction_id: number;
  document_id: number;
  tenant_id: string;
  invoice_number: string | null;
  invoice_number_confidence: string | null;
  invoice_date: string | null;
  invoice_date_confidence: string | null;
  due_date: string | null;
  due_date_confidence: string | null;
  vendor_gstin: string | null;
  vendor_gstin_confidence: string | null;
  vendor_name: string | null;
  vendor_name_confidence: string | null;
  vendor_address: string | null;
  vendor_address_confidence: string | null;
  vendor_phone: string | null;
  sub_total: string | null;
  sub_total_confidence: string | null;
  total_tax: string | null;
  total_tax_confidence: string | null;
  gross_total: string | null;
  gross_total_confidence: string | null;
  round_off: string | null;
  amount_in_words: string | null;
  cgst_amount: string | null;
  cgst_amount_confidence: string | null;
  sgst_amount: string | null;
  sgst_amount_confidence: string | null;
  igst_amount: string | null;
  igst_amount_confidence: string | null;
  cess_amount: string | null;
  cess_amount_confidence: string | null;
  place_of_supply: string | null;
  place_of_supply_confidence: string | null;
  line_items: ExtractedLineItem[] | null;
  line_items_avg_confidence: string | null;
  overall_confidence: string | null;
  critical_flags: ConfidenceFlag[] | null;
  llm_model: string | null;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  llm_raw_response: Record<string, unknown> | null;
  matched_vendor_id: number | null;
  matched_vendor_score: string | null;
  is_new_vendor: boolean;
  suggested_ledger_id: number | null;
  suggested_ledger_name: string | null;
  suggested_ledger_confidence: string | null;
  draft_transaction_id: number | null;
  review_status: ReviewDecision;
  reviewer_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseLedgerMappingRow {
  mapping_id: number;
  tenant_id: string | null;
  account_id: number;
  keyword: string;
  keyword_type: string;
  match_weight: string;
  is_active: boolean;
  match_count: number;
  last_matched_at: string | null;
  human_confirmed: boolean;
}

// ── EXTRACTED DATA TYPES ───────────────────────────────────────────────────

export interface ExtractedLineItem {
  sl_no: number;
  item_name: string;
  description?: string;
  hsn_code?: string;
  quantity: number;
  unit?: string;
  rate: number;
  taxable_value: number;
  igst_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  cess_amount: number;
  total: number;
  confidence: number;              // 0-100
}

export interface ConfidenceFlag {
  field: string;
  confidence: number;
  reason: string;
}

export interface StatusHistoryEntry {
  status: string;
  timestamp: string;
  actor: string;
}

// ── OCR EXTRACTION INPUT/OUTPUT ────────────────────────────────────────────

export interface ExtractedInvoiceData {
  invoice_number: string | null;
  invoice_number_confidence: number;
  invoice_date: string | null;
  invoice_date_confidence: number;
  due_date: string | null;
  due_date_confidence: number;

  vendor_gstin: string | null;
  vendor_gstin_confidence: number;
  vendor_name: string | null;
  vendor_name_confidence: number;
  vendor_address: string | null;
  vendor_address_confidence: number;
  vendor_phone: string | null;

  sub_total: number | null;
  sub_total_confidence: number;
  total_tax: number | null;
  total_tax_confidence: number;
  gross_total: number | null;
  gross_total_confidence: number;
  round_off: number | null;
  amount_in_words: string | null;

  cgst_amount: number | null;
  cgst_amount_confidence: number;
  sgst_amount: number | null;
  sgst_amount_confidence: number;
  igst_amount: number | null;
  igst_amount_confidence: number;
  cess_amount: number | null;
  cess_amount_confidence: number;

  place_of_supply: string | null;
  place_of_supply_confidence: number;

  line_items: ExtractedLineItem[];
  line_items_avg_confidence: number;

  overall_confidence: number;
  critical_flags: ConfidenceFlag[];
}

export interface SmartMatchResult {
  matched_vendor_id: number | null;
  matched_vendor_score: number;
  is_new_vendor: boolean;
  suggested_ledger_id: number | null;
  suggested_ledger_name: string | null;
  suggested_ledger_confidence: number;
}

export interface OcrPipelineResult {
  document_id: number;
  extraction_id: number;
  extracted: ExtractedInvoiceData;
  matching: SmartMatchResult;
  draft_transaction_id: number | null;
  review_status: ReviewDecision;
}

// ── SERVICE INPUTS ──────────────────────────────────────────────────────────

export interface UploadDocumentInput {
  tenant_id: string;
  original_filename: string;
  s3_bucket: string;
  s3_key: string;
  file_size_bytes?: number;
  mime_type?: string;
  page_count?: number;
  file_hash_sha256?: string;
  entity_type?: DocEntityType;
  uploaded_by?: string;
}

export interface StartExtractionInput {
  tenant_id: string;
  document_id: number;
  ocr_provider?: OcrProvider;
  llm_model?: LlmModel;
}

export interface ApproveDraftVoucherInput {
  extraction_id: number;
  reviewed_by: string;
  reviewer_notes?: string;
}

export interface RejectVoucherInput {
  extraction_id: number;
  reviewed_by: string;
  reason: string;
}

export interface AmendExtractionInput {
  extraction_id: number;
  amendments: Partial<ExtractedInvoiceData>;
  amended_by: string;
}

export interface CreateVendorFromExtractionInput {
  extraction_id: number;
  tenant_id: string;
  account_id: number;
  registration_type?: string;
}

// ── LLM PROMPT & RESPONSE ──────────────────────────────────────────────────

export interface OcrProviderResult {
  raw_text: string;
  pages: Array<{
    page_number: number;
    text: string;
    text_blocks: Array<{
      text: string;
      confidence: number;
      block_type: string;           // 'LINE', 'WORD', 'TABLE', 'KEY_VALUE'
      geometry?: { x: number; y: number; width: number; height: number };
    }>;
    tables: Array<{
      rows: number;
      columns: number;
      cells: Array<{ row: number; col: number; text: string; confidence: number }>;
    }>;
  }>;
  provider_raw_response: Record<string, unknown>;
  processing_time_ms: number;
}

export interface LlmExtractionPrompt {
  system_prompt: string;
  user_prompt: string;
  model: LlmModel;
  max_tokens: number;
  temperature: number;
}

export interface LlmExtractionResponse {
  extracted: ExtractedInvoiceData;
  model_used: string;
  prompt_tokens: number;
  completion_tokens: number;
  raw_response: Record<string, unknown>;
  processing_time_ms: number;
}

// ── API RESPONSE TYPES ─────────────────────────────────────────────────────

export interface DocumentPreviewResponse {
  document_id: number;
  original_filename: string;
  entity_type: DocEntityType;
  upload_status: DocumentStatus;
  s3_url: string;
  page_count: number;
  uploaded_at: string;
}

export interface ExtractionReviewResponse {
  extraction_id: number;
  document_id: number;
  original_filename: string;
  overall_confidence: number;
  review_status: ReviewDecision;
  critical_flags: ConfidenceFlag[];
  invoice: {
    number: string | null;
    date: string | null;
    vendor_name: string | null;
    vendor_gstin: string | null;
    gross_total: number | null;
  };
  vendor_match: {
    matched: boolean;
    vendor_name: string | null;
    vendor_id: number | null;
    match_score: number;
    is_new: boolean;
  };
  ledger_suggestion: {
    ledger_name: string | null;
    ledger_id: number | null;
    confidence: number;
  };
  draft_transaction_id: number | null;
}

-- ============================================================================
-- AI DOCUMENT OCR PIPELINE — Purchase Invoice / Receipt Auto-Extraction
-- PostgreSQL 15+  |  Cloud-Native Accounting Backend
-- ============================================================================
--
-- Pipeline Flow:
--   1. User uploads invoice PDF/JPEG/PNG → stored in S3
--   2. uploaded_documents row created (status: UPLOADED)
--   3. Background worker sends file to AWS Textract / Google Document AI
--   4. Raw OCR text + bounding boxes stored in ocr_raw_results
--   5. LLM (Claude/GPT) parses structured JSON from raw text
--   6. Extracted fields stored in ocr_extraction_results with confidence_score
--   7. Smart Matcher maps vendor GSTIN → gst_registrations
--   8. Expense ledger classifier maps item descriptions → accounts
--   9. PurchaseInvoiceVoucherStrategy creates DRAFT journal entries
--  10. Human reviews and clicks 'Approve' → transaction becomes live
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. ENUM TYPES
-------------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE document_status AS ENUM (
        'UPLOADED',         -- File saved to S3, not yet processed
        'QUEUED',           -- Enqueued for OCR processing
        'OCR_IN_PROGRESS',  -- Textract / DocAI processing
        'OCR_COMPLETED',    -- Raw OCR text extracted
        'LLM_PARSING',      -- LLM extracting structured JSON
        'EXTRACTION_DONE',  -- All fields extracted with confidence
        'MATCHING',         -- Vendor matching in progress
        'DRAFT_READY',      -- Draft voucher created, awaiting human review
        'APPROVED',         -- Human approved and journal posted
        'REJECTED',         -- Human rejected (bad quality / wrong doc)
        'FAILED'            -- Processing failed (error)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE doc_entity_type AS ENUM (
        'PURCHASE_INVOICE',      -- Vendor invoice for goods/services
        'EXPENSE_RECEIPT',       -- Small expense receipt (no GST)
        'CREDIT_NOTE',           -- Purchase return credit note
        'DEBIT_NOTE',            -- Purchase debit note
        'BANK_STATEMENT',        -- Future: bank statement
        'OTHER'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE review_decision AS ENUM (
        'PENDING_REVIEW',        -- Awaiting human
        'AUTO_APPROVED',         -- AI confidence ≥ 95%
        'FLAGGED',               -- Confidence < 80% on any critical field
        'AMENDED',               -- Human corrected fields before approving
        'APPROVED',
        'REJECTED'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-------------------------------------------------------------------------------
-- 2. UPLOADED DOCUMENTS — Track every file through the pipeline
-------------------------------------------------------------------------------

CREATE TABLE uploaded_documents (
    document_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID          NOT NULL,

    -- File metadata
    original_filename VARCHAR(500)  NOT NULL,
    s3_bucket         VARCHAR(200)  NOT NULL,
    s3_key            VARCHAR(1000) NOT NULL,              -- path within bucket
    s3_url            VARCHAR(2000) NOT NULL,              -- full presigned / public URL
    file_size_bytes   BIGINT,                              -- from S3 metadata
    mime_type         VARCHAR(100),                        -- 'application/pdf', 'image/jpeg', 'image/png'
    page_count        INT           DEFAULT 1,
    file_hash_sha256  VARCHAR(64),                         -- for deduplication

    -- Document type
    entity_type       doc_entity_type NOT NULL DEFAULT 'PURCHASE_INVOICE',

    -- Pipeline status
    upload_status     document_status NOT NULL DEFAULT 'UPLOADED',
    status_history    JSONB          NOT NULL DEFAULT '[]'::jsonb,
    error_message     TEXT,

    -- OCR metadata
    ocr_provider      VARCHAR(50),                         -- 'AWS_TEXTRACT', 'GOOGLE_DOC_AI', 'TESSERACT'
    ocr_job_id        VARCHAR(200),                        -- provider's async job ID
    ocr_started_at    TIMESTAMPTZ,
    ocr_completed_at  TIMESTAMPTZ,
    ocr_tokens_used   INT           DEFAULT 0,             -- LLM token count for cost tracking
    ocr_cost_estimate NUMERIC(10,4),                       -- estimated USD cost

    -- Processing metadata
    processing_time_ms INT,                                -- total pipeline time

    -- Who uploaded it
    uploaded_by       VARCHAR(100),
    uploaded_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, file_hash_sha256)                   -- prevent duplicate uploads
);

CREATE INDEX idx_upload_status ON uploaded_documents(tenant_id, upload_status);
CREATE INDEX idx_upload_entity_type ON uploaded_documents(tenant_id, entity_type, upload_status);
CREATE INDEX idx_upload_created ON uploaded_documents(tenant_id, created_at DESC);

-------------------------------------------------------------------------------
-- 3. OCR RAW RESULTS — Raw text + bounding boxes from OCR engine
-------------------------------------------------------------------------------

CREATE TABLE ocr_raw_results (
    raw_result_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id       BIGINT        NOT NULL REFERENCES uploaded_documents(document_id),

    page_number       INT           NOT NULL DEFAULT 1,
    raw_text          TEXT          NOT NULL,              -- full text extracted from this page

    -- Structured blocks (JSON array of { text, confidence, bounding_box, block_type })
    text_blocks       JSONB,                               -- parsed block-level data
    table_blocks      JSONB,                               -- detected tables with rows/cells

    -- Raw provider response (full payload for debugging)
    provider_response JSONB,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (document_id, page_number)
);

CREATE INDEX idx_ocr_raw_doc ON ocr_raw_results(document_id);

-------------------------------------------------------------------------------
-- 4. OCR EXTRACTION RESULTS — Structured fields with confidence scores
-------------------------------------------------------------------------------

CREATE TABLE ocr_extraction_results (
    extraction_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id       BIGINT        NOT NULL UNIQUE REFERENCES uploaded_documents(document_id),
    tenant_id         UUID          NOT NULL,

    -- ── Header fields ──
    invoice_number    VARCHAR(50),
    invoice_number_confidence NUMERIC(5,2),                -- 0.00 to 100.00
    invoice_date      DATE,
    invoice_date_confidence NUMERIC(5,2),
    due_date          DATE,
    due_date_confidence NUMERIC(5,2),

    -- ── Vendor fields ──
    vendor_gstin      VARCHAR(15),
    vendor_gstin_confidence NUMERIC(5,2),
    vendor_name       VARCHAR(300),
    vendor_name_confidence NUMERIC(5,2),
    vendor_address    TEXT,
    vendor_address_confidence NUMERIC(5,2),
    vendor_phone      VARCHAR(20),

    -- ── Amounts ──
    sub_total         NUMERIC(18,2),
    sub_total_confidence    NUMERIC(5,2),
    total_tax         NUMERIC(18,2),
    total_tax_confidence    NUMERIC(5,2),
    gross_total       NUMERIC(18,2),
    gross_total_confidence  NUMERIC(5,2),
    round_off         NUMERIC(18,2),
    amount_in_words   TEXT,

    -- ── Tax breakdown (extracted or LLM-inferred from total) ──
    cgst_amount       NUMERIC(18,2),
    cgst_amount_confidence   NUMERIC(5,2),
    sgst_amount       NUMERIC(18,2),
    sgst_amount_confidence   NUMERIC(5,2),
    igst_amount       NUMERIC(18,2),
    igst_amount_confidence   NUMERIC(5,2),
    cess_amount       NUMERIC(18,2),
    cess_amount_confidence   NUMERIC(5,2),

    -- ── Place of Supply ──
    place_of_supply   VARCHAR(2),                          -- 2-digit state code
    place_of_supply_confidence NUMERIC(5,2),

    -- ── Line items (JSON array) ──
    line_items        JSONB,                               -- [{ sl_no, item_name, description, hsn_code, qty, unit, rate, taxable_value, igst_amt, cgst_amt, sgst_amt, total, item_confidence }]
    line_items_avg_confidence NUMERIC(5,2),

    -- ── Aggregate confidence ──
    overall_confidence NUMERIC(5,2),                       -- mean of all field confidences
    critical_flags    JSONB,                               -- [{ field: 'vendor_gstin', confidence: 45, reason: 'Low OCR quality' }]

    -- ── LLM metadata ──
    llm_model         VARCHAR(50),                         -- 'claude-3-opus', 'gpt-4o', 'llama-3-70b'
    llm_prompt_tokens INT,
    llm_completion_tokens INT,
    llm_raw_response  JSONB,                               -- full LLM JSON response for debugging

    -- ── Smart matching results ──
    matched_vendor_id BIGINT REFERENCES gst_registrations(gst_registration_id),
    matched_vendor_score NUMERIC(5,2),                     -- fuzzy match confidence
    is_new_vendor     BOOLEAN NOT NULL DEFAULT FALSE,
    suggested_ledger_id BIGINT REFERENCES accounts(account_id),
    suggested_ledger_name VARCHAR(200),
    suggested_ledger_confidence NUMERIC(5,2),

    -- ── Draft voucher link ──
    draft_transaction_id BIGINT REFERENCES transactions(transaction_id),
    review_status     review_decision NOT NULL DEFAULT 'PENDING_REVIEW',
    reviewer_notes    TEXT,
    reviewed_by       VARCHAR(100),
    reviewed_at       TIMESTAMPTZ,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_ocr_ext_doc ON ocr_extraction_results(document_id);
CREATE INDEX idx_ocr_ext_confidence ON ocr_extraction_results(overall_confidence)
    WHERE review_status = 'PENDING_REVIEW';
CREATE INDEX idx_ocr_ext_matched_vendor ON ocr_extraction_results(matched_vendor_id)
    WHERE matched_vendor_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 5. EXPENSE LEDGER MAPPING — ML classification training data + inference
--    Seeded with common Indian business expense categories.
-------------------------------------------------------------------------------

CREATE TABLE expense_ledger_mapping (
    mapping_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID,
    account_id        BIGINT        NOT NULL REFERENCES accounts(account_id),

    -- Keywords / phrases used for classification
    keyword           VARCHAR(200)  NOT NULL,
    keyword_type      VARCHAR(30)   DEFAULT 'PRODUCT',     -- 'PRODUCT', 'SERVICE', 'VENDOR_TYPE', 'HSN_DESCRIPTION'
    match_weight      NUMERIC(5,2)  DEFAULT 1.0,           -- boost factor for this keyword
    is_active         BOOLEAN       NOT NULL DEFAULT TRUE,

    -- Frequency tracking (self-learning)
    match_count       INT           DEFAULT 0,             -- times this mapping was used
    last_matched_at   TIMESTAMPTZ,
    human_confirmed   BOOLEAN       DEFAULT FALSE,         -- confirmed by human review

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, keyword, account_id)
);

-- GIN trigram index for fast fuzzy keyword search
CREATE INDEX idx_expense_keyword_trgm
    ON expense_ledger_mapping USING GIN (keyword gin_trgm_ops);

-- Seed data: Common Indian business expenses
INSERT INTO expense_ledger_mapping (account_id, keyword, keyword_type, human_confirmed)
VALUES
    -- Computer & IT
    (11, 'computer', 'PRODUCT', TRUE),
    (11, 'laptop', 'PRODUCT', TRUE),
    (11, 'monitor', 'PRODUCT', TRUE),
    (11, 'printer', 'PRODUCT', TRUE),
    (11, 'server', 'PRODUCT', TRUE),
    (11, 'keyboard', 'PRODUCT', TRUE),
    (11, 'software', 'PRODUCT', TRUE),
    (11, 'hard disk', 'PRODUCT', TRUE),
    (11, 'dell', 'PRODUCT', TRUE),
    (11, 'hp', 'PRODUCT', TRUE),
    (11, 'lenovo', 'PRODUCT', TRUE),

    -- Office Supplies
    (11, 'stationery', 'PRODUCT', TRUE),
    (11, 'paper', 'PRODUCT', TRUE),
    (11, 'toner', 'PRODUCT', TRUE),
    (11, 'cartridge', 'PRODUCT', TRUE),

    -- Rent
    (11, 'rent', 'SERVICE', TRUE),
    (11, 'lease', 'SERVICE', TRUE),

    -- Professional Fees
    (11, 'consulting', 'SERVICE', TRUE),
    (11, 'legal', 'SERVICE', TRUE),
    (11, 'audit', 'SERVICE', TRUE),
    (11, 'ca services', 'SERVICE', TRUE),

    -- Marketing & Advertising
    (11, 'advertisement', 'SERVICE', TRUE),
    (11, 'marketing', 'SERVICE', TRUE),
    (11, 'facebook ads', 'SERVICE', TRUE),
    (11, 'google ads', 'SERVICE', TRUE),
    (11, 'social media', 'SERVICE', TRUE),

    -- Travel & Conveyance
    (11, 'travel', 'SERVICE', TRUE),
    (11, 'hotel', 'SERVICE', TRUE),
    (11, 'flight', 'SERVICE', TRUE),
    (11, 'taxi', 'SERVICE', TRUE),
    (11, 'fuel', 'PRODUCT', TRUE),
    (11, 'petrol', 'PRODUCT', TRUE),
    (11, 'diesel', 'PRODUCT', TRUE),

    -- Food & Refreshments
    (11, 'food', 'PRODUCT', TRUE),
    (11, 'lunch', 'SERVICE', TRUE),
    (11, 'dinner', 'SERVICE', TRUE),
    (11, 'catering', 'SERVICE', TRUE),

    -- Electricity & Utilities
    (11, 'electricity', 'SERVICE', TRUE),
    (11, 'power', 'SERVICE', TRUE),
    (11, 'water', 'SERVICE', TRUE),
    (11, 'internet', 'SERVICE', TRUE),
    (11, 'broadband', 'SERVICE', TRUE),
    (11, 'telephone', 'SERVICE', TRUE),
    (11, 'mobile', 'SERVICE', TRUE),

    -- Repairs & Maintenance
    (11, 'repair', 'SERVICE', TRUE),
    (11, 'maintenance', 'SERVICE', TRUE),
    (11, 'amc', 'SERVICE', TRUE),

    -- Insurance
    (11, 'insurance', 'SERVICE', TRUE),

    -- Courier & Postage
    (11, 'courier', 'SERVICE', TRUE),
    (11, 'postage', 'SERVICE', TRUE),
    (11, 'shipping', 'SERVICE', TRUE),
    (11, 'delivery', 'SERVICE', TRUE)
ON CONFLICT DO NOTHING;

-------------------------------------------------------------------------------
-- 6. FUNCTION: Calculate aggregate confidence score
--    Returns true if all critical fields (GSTIN, total, invoice number) have
--    confidence ≥ 80%. Otherwise flags for mandatory human review.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_confidence_flags(
    p_extraction_id BIGINT
)
RETURNS TABLE (
    overall_confidence NUMERIC(5,2),
    critical_flags     JSONB,
    needs_review       BOOLEAN
) AS $$
DECLARE
    v_rec RECORD;
    v_flags JSONB := '[]'::jsonb;
    v_conf_sum NUMERIC(10,2) := 0;
    v_conf_count INT := 0;
BEGIN
    SELECT * INTO v_rec FROM ocr_extraction_results WHERE extraction_id = p_extraction_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 0, '[]'::jsonb, TRUE;
        RETURN;
    END IF;

    -- Check critical fields: any confidence < 80 → flag it
    IF COALESCE(v_rec.gross_total_confidence, 0) < 80 THEN
        v_flags := v_flags || jsonb_build_object(
            'field', 'gross_total', 'confidence', v_rec.gross_total_confidence, 'reason', 'Total amount low confidence'
        );
    END IF;

    IF COALESCE(v_rec.invoice_number_confidence, 0) < 80 THEN
        v_flags := v_flags || jsonb_build_object(
            'field', 'invoice_number', 'confidence', v_rec.invoice_number_confidence, 'reason', 'Invoice number unclear'
        );
    END IF;

    IF COALESCE(v_rec.vendor_gstin_confidence, 0) < 80 THEN
        v_flags := v_flags || jsonb_build_object(
            'field', 'vendor_gstin', 'confidence', v_rec.vendor_gstin_confidence, 'reason', 'Vendor GSTIN low confidence'
        );
    END IF;

    IF COALESCE(v_rec.invoice_date_confidence, 0) < 80 THEN
        v_flags := v_flags || jsonb_build_object(
            'field', 'invoice_date', 'confidence', v_rec.invoice_date_confidence, 'reason', 'Invoice date unclear'
        );
    END IF;

    IF COALESCE(v_rec.line_items_avg_confidence, 0) < 70 THEN
        v_flags := v_flags || jsonb_build_object(
            'field', 'line_items', 'confidence', v_rec.line_items_avg_confidence, 'reason', 'Line item details low confidence'
        );
    END IF;

    -- Compute mean of all numeric confidence fields
    SELECT AVG(conf) INTO v_rec.overall_confidence
    FROM UNNEST(ARRAY[
        COALESCE(v_rec.invoice_number_confidence, 0),
        COALESCE(v_rec.invoice_date_confidence, 0),
        COALESCE(v_rec.vendor_gstin_confidence, 0),
        COALESCE(v_rec.vendor_name_confidence, 0),
        COALESCE(v_rec.gross_total_confidence, 0),
        COALESCE(v_rec.line_items_avg_confidence, 0),
        COALESCE(v_rec.matched_vendor_score, 0)
    ]) AS conf;

    RETURN QUERY SELECT
        COALESCE(ROUND(v_rec.overall_confidence, 2), 0),
        v_flags,
        (jsonb_array_length(v_flags) > 0);
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 7. FUNCTION: Find best matching vendor from gst_registrations
--    Prefers exact GSTIN match; falls back to fuzzy name with pg_trgm.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_vendor_from_extraction(
    p_extraction_id BIGINT
)
RETURNS TABLE (
    matched_id    BIGINT,
    matched_score NUMERIC(5,2),
    is_new        BOOLEAN
) AS $$
DECLARE
    v_rec RECORD;
    v_best_id BIGINT;
    v_best_score NUMERIC(5,2) := 0;
    v_fuzzy RECORD;
BEGIN
    SELECT vendor_gstin, vendor_name INTO v_rec
    FROM ocr_extraction_results WHERE extraction_id = p_extraction_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::BIGINT, 0, TRUE;
        RETURN;
    END IF;

    -- Step 1: Exact GSTIN match → 100% confidence
    IF v_rec.vendor_gstin IS NOT NULL THEN
        SELECT gr.gst_registration_id INTO v_best_id
        FROM gst_registrations gr
        WHERE gr.gstin = v_rec.vendor_gstin AND gr.is_active = TRUE
        LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT v_best_id, 100.00, FALSE;
            RETURN;
        END IF;
    END IF;

    -- Step 2: Fuzzy name match using pg_trgm similarity
    IF v_rec.vendor_name IS NOT NULL THEN
        SELECT gr.gst_registration_id, similarity(gr.legal_name, v_rec.vendor_name) AS sim
        INTO v_fuzzy
        FROM gst_registrations gr
        WHERE gr.is_active = TRUE
        ORDER BY sim DESC
        LIMIT 1;

        IF FOUND AND v_fuzzy.sim > 0.40 THEN
            RETURN QUERY SELECT v_fuzzy.gst_registration_id, ROUND(v_fuzzy.sim * 100, 2), FALSE;
            RETURN;
        END IF;

        -- Also try trade_name
        SELECT gr.gst_registration_id, similarity(COALESCE(gr.trade_name, gr.legal_name), v_rec.vendor_name) AS sim
        INTO v_fuzzy
        FROM gst_registrations gr
        WHERE gr.is_active = TRUE
        ORDER BY sim DESC
        LIMIT 1;

        IF FOUND AND v_fuzzy.sim > 0.45 THEN
            RETURN QUERY SELECT v_fuzzy.gst_registration_id, ROUND(v_fuzzy.sim * 100, 2), FALSE;
            RETURN;
        END IF;
    END IF;

    -- No match found → new vendor
    RETURN QUERY SELECT NULL::BIGINT, 0, TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 8. FUNCTION: Classify expense ledger from item descriptions
--    Uses trigram similarity on expense_ledger_mapping keywords.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION classify_expense_ledger(
    p_item_description TEXT,
    p_tenant_id        UUID DEFAULT NULL
)
RETURNS TABLE (
    account_id   BIGINT,
    account_name VARCHAR(200),
    confidence   NUMERIC(5,2)
) AS $$
DECLARE
    v_best RECORD;
BEGIN
    -- Step 1: Try tenant-specific mappings first
    IF p_tenant_id IS NOT NULL THEN
        SELECT elm.account_id, a.account_name,
               similarity(elm.keyword, p_item_description) * elm.match_weight AS score
        INTO v_best
        FROM expense_ledger_mapping elm
        JOIN accounts a ON a.account_id = elm.account_id AND a.is_active = TRUE
        WHERE elm.is_active = TRUE
          AND (elm.tenant_id = p_tenant_id OR elm.tenant_id IS NULL)
          AND similarity(elm.keyword, p_item_description) > 0.15
        ORDER BY score DESC
        LIMIT 1;

        IF FOUND THEN
            RETURN QUERY SELECT v_best.account_id, v_best.account_name, ROUND(v_best.score * 100, 2);
            RETURN;
        END IF;
    END IF;

    -- Step 2: Global keyword match
    SELECT elm.account_id, a.account_name,
           similarity(elm.keyword, p_item_description) * elm.match_weight AS score
    INTO v_best
    FROM expense_ledger_mapping elm
    JOIN accounts a ON a.account_id = elm.account_id AND a.is_active = TRUE
    WHERE elm.is_active = TRUE
      AND similarity(elm.keyword, p_item_description) > 0.15
    ORDER BY score DESC
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT v_best.account_id, v_best.account_name, ROUND(v_best.score * 100, 2);
        RETURN;
    END IF;

    -- Step 3: Fallback to direct account matching
    SELECT a.account_id, a.account_name, similarity(a.account_name, p_item_description)
    INTO v_best
    FROM accounts a
    WHERE a.is_active = TRUE
      AND a.account_type = 'Expense'
      AND similarity(a.account_name, p_item_description) > 0.10
    ORDER BY similarity(a.account_name, p_item_description) DESC
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT v_best.account_id, v_best.account_name, ROUND(v_best.similarity * 100, 2);
        RETURN;
    END IF;

    -- No match
    RETURN QUERY SELECT NULL::BIGINT, NULL::VARCHAR, 0;
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 9. HELPER: append status_history
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION append_status_history_ocr(
    p_history JSONB,
    p_status  TEXT,
    p_actor   VARCHAR(100) DEFAULT 'system'
)
RETURNS JSONB AS $$
BEGIN
    RETURN p_history || jsonb_build_object(
        'status',    p_status,
        'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'actor',     p_actor
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;
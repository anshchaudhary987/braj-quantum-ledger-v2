-- ============================================================================
-- TALLY PRIME → PostgreSQL MIGRATION ENGINE
-- Streaming XML Import with Batch Commit + Rollback + Verification
-- PostgreSQL 15+  |  Cloud-Native Accounting Backend
-- ============================================================================
--
-- Strategy:
--   Phase 1 (Masters): Parse <LEDGER> + <GROUP> → upsert into accounts via
--                     tally_master_mapping. Preserve Tally GUID for dedup.
--   Phase 2 (Vouchers): Parse <VOUCHER> chunks → batch-insert into
--                      transactions + journal_entries with import_batch_id.
--                      Each batch of 500 vouchers = 1 DB transaction.
--   Phase 3 (Verify): Compare opening balances → generate import summary.
--
-- Rollback Safety:
--   - Masters: uses ON CONFLICT (tally_guid) DO NOTHING → idempotent
--   - Vouchers: batch commits (500 at a time). Failed batch = rollback
--     only that batch; successfully committed batches are NOT rolled back.
--     Full import tracking via import_batch_id in transactions.metadata.
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. TALLY IMPORT BATCHES — One row per upload/import session
-------------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE tally_import_status AS ENUM (
        'UPLOADED',           -- File received, not yet processed
        'PARSING',            -- XML streaming in progress
        'MASTERS_IMPORTED',   -- LEDGERs and GROUPs imported
        'VOUCHERS_IMPORTING', -- Batch-importing vouchers
        'COMPLETED',          -- All data imported successfully
        'COMPLETED_WITH_ERRORS', -- Imported but some vouchers had errors
        'FAILED',             -- Fatal error, import aborted
        'ROLLED_BACK'         -- Full rollback completed
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE tally_import_batches (
    import_batch_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID         NOT NULL,

    -- File metadata
    original_filename VARCHAR(500)  NOT NULL,
    s3_key            VARCHAR(1000),
    file_size_bytes   BIGINT,
    tally_version     VARCHAR(20),                  -- 'TallyPrime 4.0', 'Tally.ERP 9', etc.
    company_name_in_tally VARCHAR(300),             -- from <ENVELOPE><BODY><IMPORTDATA><REQUESTDESC><COMPANYNAME>

    -- Processing stats
    import_status     tally_import_status NOT NULL DEFAULT 'UPLOADED',
    status_history    JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message     TEXT,

    -- Master stats
    total_groups      INT DEFAULT 0,
    total_ledgers     INT DEFAULT 0,
    masters_imported  INT DEFAULT 0,
    masters_skipped   INT DEFAULT 0,                -- duplicates

    -- Voucher stats
    total_vouchers    INT DEFAULT 0,
    vouchers_imported INT DEFAULT 0,
    vouchers_failed   INT DEFAULT 0,
    vouchers_skipped  INT DEFAULT 0,                -- duplicate idempotency
    current_batch_num INT DEFAULT 0,
    total_batches     INT DEFAULT 0,

    -- Timing
    parsing_started_at   TIMESTAMPTZ,
    parsing_completed_at TIMESTAMPTZ,
    masters_started_at   TIMESTAMPTZ,
    masters_completed_at TIMESTAMPTZ,
    vouchers_started_at  TIMESTAMPTZ,
    vouchers_completed_at TIMESTAMPTZ,
    total_duration_ms    INT,

    -- Verification
    tally_grand_total_debit  NUMERIC(18,2),
    imported_grand_total_debit NUMERIC(18,2),
    tally_grand_total_credit NUMERIC(18,2),
    imported_grand_total_credit NUMERIC(18,2),

    -- User
    uploaded_by       VARCHAR(100),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tally_batch_tenant ON tally_import_batches(tenant_id, import_status);
CREATE INDEX idx_tally_batch_created ON tally_import_batches(tenant_id, created_at DESC);

-------------------------------------------------------------------------------
-- 2. TALLY MASTER MAPPING — Link Tally GUIDs/Names to internal account_ids
--    Populated during Phase 1 (Master import). Looked up during Phase 2 (Voucher
--    import) to resolve ledger references in ALLLEDGERENTRIES.LIST.
-------------------------------------------------------------------------------

CREATE TABLE tally_master_mapping (
    mapping_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID         NOT NULL,
    import_batch_id   UUID         NOT NULL REFERENCES tally_import_batches(import_batch_id),

    -- Tally identifiers
    tally_guid        VARCHAR(50),                   -- <GUID> element — unique per Tally master
    tally_name        VARCHAR(300) NOT NULL,          -- <NAME> element
    tally_parent_name VARCHAR(300),                   -- <PARENT> group name
    tally_master_type VARCHAR(20)  NOT NULL           -- 'LEDGER' or 'GROUP'
                      CHECK (tally_master_type IN ('LEDGER', 'GROUP')),

    -- What Tally says about it
    tally_opening_balance NUMERIC(18,2) DEFAULT 0,

    -- Internal mapping
    mapped_account_id BIGINT REFERENCES accounts(account_id),
    is_system_default BOOLEAN NOT NULL DEFAULT FALSE, -- 'Cash', 'Profit & Loss A/c' etc.

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, tally_guid)
);

CREATE INDEX idx_tally_map_guid ON tally_master_mapping(tenant_id, tally_guid)
    WHERE tally_guid IS NOT NULL;
CREATE INDEX idx_tally_map_name ON tally_master_mapping(tenant_id, tally_name);
CREATE INDEX idx_tally_map_account ON tally_master_mapping(mapped_account_id);

-------------------------------------------------------------------------------
-- 3. TALLY IMPORT ERRORS — Per-voucher error log
--    Records each failed voucher so the user can inspect and retry.
-------------------------------------------------------------------------------

CREATE TABLE tally_import_errors (
    error_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    import_batch_id   UUID         NOT NULL REFERENCES tally_import_batches(import_batch_id),
    batch_number      INT          NOT NULL,           -- which 500-voucher batch
    voucher_index     INT,                              -- position in the XML stream

    -- Tally identifiers
    tally_voucher_key VARCHAR(100),                    -- Tally's unique voucher key for dedup
    tally_voucher_type VARCHAR(50),                     -- Sales, Purchase, Receipt, etc.
    tally_voucher_date VARCHAR(20),

    -- Error details
    error_code        VARCHAR(50)  NOT NULL,
    error_message     TEXT         NOT NULL,
    raw_xml_fragment  TEXT,                             -- the offending XML snippet (truncated)

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tally_errors_batch ON tally_import_errors(import_batch_id, batch_number);

-------------------------------------------------------------------------------
-- 4. FUNCTION: Map Tally account type → internal account_type
--    Converts Tally's group classification to our chart-of-accounts types.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tally_group_to_account_type(
    p_tally_group_name VARCHAR(300)
)
RETURNS VARCHAR(20) AS $$
BEGIN
    -- Primary groups in Tally
    IF p_tally_group_name ILIKE '%bank%' OR p_tally_group_name ILIKE '%cash%' THEN
        RETURN 'Asset';
    ELSIF p_tally_group_name ILIKE '%sundry debtor%' OR p_tally_group_name ILIKE '%accounts receivable%' THEN
        RETURN 'Asset';
    ELSIF p_tally_group_name ILIKE '%sundry creditor%' OR p_tally_group_name ILIKE '%accounts payable%' THEN
        RETURN 'Liability';
    ELSIF p_tally_group_name ILIKE '%income%' OR p_tally_group_name ILIKE '%sales%' OR p_tally_group_name ILIKE '%revenue%' THEN
        RETURN 'Income';
    ELSIF p_tally_group_name ILIKE '%expense%' OR p_tally_group_name ILIKE '%purchase%' OR p_tally_group_name ILIKE '%cost%' THEN
        RETURN 'Expense';
    ELSIF p_tally_group_name ILIKE '%loan%' OR p_tally_group_name ILIKE '%liabilit%' THEN
        RETURN 'Liability';
    ELSIF p_tally_group_name ILIKE '%capital%' OR p_tally_group_name ILIKE '%reserves%' THEN
        RETURN 'Equity';
    ELSIF p_tally_group_name ILIKE '%stock%' OR p_tally_group_name ILIKE '%fixed asse%' OR p_tally_group_name ILIKE '%invest%' THEN
        RETURN 'Asset';
    ELSE
        -- Default: try to infer from is_revenue flag (not available here; assume Expense)
        RETURN 'Expense';
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-------------------------------------------------------------------------------
-- 5. FUNCTION: Compute ltree path from parent hierarchy
--    Given a parent_name, traverses tally_master_mapping to build the path.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tally_build_path(
    p_parent_name VARCHAR(300),
    p_tenant_id   UUID,
    p_batch_id    UUID
)
RETURNS LTREE AS $$
DECLARE
    v_parent_path LTREE;
    v_parent_id   BIGINT;
BEGIN
    -- Find the parent in our mapping or in existing accounts
    SELECT tmm.mapped_account_id, a.path
    INTO v_parent_id, v_parent_path
    FROM tally_master_mapping tmm
    JOIN accounts a ON a.account_id = tmm.mapped_account_id
    WHERE tmm.tenant_id = p_tenant_id
      AND tmm.tally_name = p_parent_name
      AND tmm.tally_master_type = 'GROUP'
    LIMIT 1;

    IF FOUND THEN
        RETURN v_parent_path;
    END IF;

    -- Try existing accounts by name
    SELECT a.path INTO v_parent_path
    FROM accounts a
    WHERE a.account_name = p_parent_name AND a.is_active = TRUE
    LIMIT 1;

    IF FOUND THEN
        RETURN v_parent_path;
    END IF;

    -- Fallback: root
    RETURN ''::ltree;
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 6. FUNCTION: Get verification summary (Tally vs Imported)
--    Compares closing balances from the Tally XML against our account_balances.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION verify_tally_import(
    p_batch_id UUID
)
RETURNS TABLE (
    section           TEXT,
    tally_amount      NUMERIC(18,2),
    imported_amount   NUMERIC(18,2),
    difference        NUMERIC(18,2),
    status            TEXT
) AS $$
DECLARE
    v_tally_debit  NUMERIC(18,2);
    v_import_debit NUMERIC(18,2);
    v_tally_credit NUMERIC(18,2);
    v_import_credit NUMERIC(18,2);
    v_diff_debit   NUMERIC(18,2);
    v_diff_credit  NUMERIC(18,2);
BEGIN
    -- Total Debits from Tally (sum of voucher debits we tracked)
    SELECT COALESCE(tally_grand_total_debit, 0)  INTO v_tally_debit  FROM tally_import_batches WHERE import_batch_id = p_batch_id;
    SELECT COALESCE(imported_grand_total_debit,0) INTO v_import_debit FROM tally_import_batches WHERE import_batch_id = p_batch_id;
    SELECT COALESCE(tally_grand_total_credit, 0) INTO v_tally_credit FROM tally_import_batches WHERE import_batch_id = p_batch_id;
    SELECT COALESCE(imported_grand_total_credit,0) INTO v_import_credit FROM tally_import_batches WHERE import_batch_id = p_batch_id;

    v_diff_debit  := v_tally_debit  - v_import_debit;
    v_diff_credit := v_tally_credit - v_import_credit;

    RETURN QUERY
    SELECT 'Total Debits'::TEXT,  v_tally_debit,  v_import_debit,  v_diff_debit,  CASE WHEN v_diff_debit  = 0 THEN 'MATCH' ELSE 'MISMATCH' END;
    RETURN QUERY
    SELECT 'Total Credits'::TEXT, v_tally_credit, v_import_credit, v_diff_credit, CASE WHEN v_diff_credit = 0 THEN 'MATCH' ELSE 'MISMATCH' END;

    -- Check per-account balances
    RETURN QUERY
    SELECT
        'Account: ' || tmm.tally_name,
        tmm.tally_opening_balance,
        COALESCE(ab.closing_balance, 0),
        tmm.tally_opening_balance - COALESCE(ab.closing_balance, 0),
        CASE
            WHEN tmm.tally_opening_balance = COALESCE(ab.closing_balance, 0) THEN 'MATCH'
            ELSE 'MISMATCH'
        END
    FROM tally_master_mapping tmm
    LEFT JOIN account_balances ab ON ab.account_id = tmm.mapped_account_id
        AND ab.financial_year = EXTRACT(YEAR FROM CURRENT_DATE)::INT
    WHERE tmm.import_batch_id = p_batch_id
      AND tmm.tally_master_type = 'LEDGER';
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 7. HELPER: append status_history
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION append_status_history_tally(
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
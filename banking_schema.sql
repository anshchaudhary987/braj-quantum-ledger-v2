-- ============================================================================
-- BANKING & RECONCILIATION MODULE — Indian Market
-- Bank Statements + Auto-Match + Account Aggregator Integration
-- ============================================================================

-- Enable pgcrypto for encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Enable trigram extension for fuzzy text matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-------------------------------------------------------------------------------
-- 1. BANK ACCOUNTS — Linked to Chart of Accounts
-------------------------------------------------------------------------------
CREATE TABLE bank_accounts (
    bank_account_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id              BIGINT       NOT NULL,

    -- Link to the accounting ledger (Cash/Bank account in COA)
    account_id              BIGINT       NOT NULL UNIQUE
                            REFERENCES accounts(account_id),

    -- Bank identification
    bank_name               VARCHAR(100) NOT NULL,
    branch_name             VARCHAR(100),
    ifsc_code               VARCHAR(11)  NOT NULL,

    -- PII — encrypted at rest, hashed for lookups
    account_number_encrypted BYTEA       NOT NULL,       -- pgp_sym_encrypt('1234567890', 'master_key')
    account_number_hash      VARCHAR(64) NOT NULL,       -- sha256(account_number) for dedup
    account_number_masked    VARCHAR(20) NOT NULL,       -- XXXXXXXXXX7890 for display

    account_type             VARCHAR(20)  NOT NULL DEFAULT 'CURRENT'
                             CHECK (account_type IN ('SAVINGS', 'CURRENT', 'OVERDRAFT', 'CASH_CREDIT', 'OD')),

    -- AA integration metadata
    aa_fip_id                VARCHAR(50),                -- Financial Information Provider ID (bank identifier in AA)
    aa_fip_name              VARCHAR(100),
    aa_account_ref           VARCHAR(200),               -- AA's account reference
    is_aa_enabled            BOOLEAN      NOT NULL DEFAULT FALSE,
    aa_last_synced_at        TIMESTAMPTZ,

    -- Opening balance for reconciliation
    opening_balance          NUMERIC(18,2),
    opening_balance_date     DATE,

    is_active                BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_accounts_company ON bank_accounts(company_id);
CREATE INDEX idx_bank_accounts_hash    ON bank_accounts(account_number_hash);

-------------------------------------------------------------------------------
-- 2. BANK STATEMENTS — Raw bank transaction data
-------------------------------------------------------------------------------
CREATE TABLE bank_statements (
    bank_statement_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id            BIGINT       NOT NULL,
    bank_account_id       BIGINT       NOT NULL REFERENCES bank_accounts(bank_account_id),

    -- Raw bank data
    transaction_date      DATE         NOT NULL,
    value_date            DATE,                          -- actual clearing/settlement date
    description           TEXT         NOT NULL,
    transaction_ref       VARCHAR(200),                  -- UTR / Cheque / NEFT ref number
    transaction_type      VARCHAR(30),                   -- 'NEFT','RTGS','IMPS','UPI','CHEQUE','CASH','ECS','NACH'

    debit_amount          NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    credit_amount         NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    running_balance       NUMERIC(18,2),

    -- Source tracking
    source                VARCHAR(20)  NOT NULL DEFAULT 'IMPORT'
                          CHECK (source IN ('IMPORT', 'AA_FETCH', 'MANUAL')),
    source_file_name      VARCHAR(200),
    source_line_number    INT,
    import_batch_id       UUID,

    -- Raw data preservation for audit
    raw_data              JSONB,                         -- original row from bank CSV/JSON for traceability

    -- ===============================================================
    -- RECONCILIATION
    -- ===============================================================
    reconciliation_status VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                          CHECK (reconciliation_status IN (
                              'PENDING', 'MATCHED', 'SUGGESTED',
                              'UNRECONCILED', 'PARTIALLY_MATCHED',
                              'IGNORED', 'DUPLICATE'
                          )),

    -- Match result
    matched_journal_entry_id BIGINT REFERENCES journal_entries(entry_id),
    matched_transaction_id   BIGINT REFERENCES transactions(transaction_id),
    match_confidence         NUMERIC(3,2)               -- 0.00 to 1.00
                             CHECK (match_confidence >= 0 AND match_confidence <= 1),
    match_rule               VARCHAR(50),               -- which matching rule fired

    -- User reconciliation
    reconciled_by          BIGINT,                       -- user_id
    reconciled_at          TIMESTAMPTZ,
    reconciliation_notes   TEXT,

    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Indexes for the matching engine (heavily used in auto-match queries)
CREATE INDEX idx_bank_stmt_unmatched
    ON bank_statements(bank_account_id, reconciliation_status, transaction_date)
    WHERE reconciliation_status IN ('PENDING', 'UNRECONCILED');

CREATE INDEX idx_bank_stmt_date_amount
    ON bank_statements(bank_account_id, transaction_date, debit_amount, credit_amount,
                       reconciliation_status);

CREATE INDEX idx_bank_stmt_ref
    ON bank_statements(transaction_ref)
    WHERE transaction_ref IS NOT NULL;

-- Trigram index for fuzzy description matching
CREATE INDEX idx_bank_stmt_desc_trgm
    ON bank_statements USING GIN (description gin_trgm_ops);

-------------------------------------------------------------------------------
-- 3. AA CONSENTS — Account Aggregator consent artifacts
-------------------------------------------------------------------------------
CREATE TABLE aa_consents (
    consent_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id            BIGINT       NOT NULL,
    bank_account_id       BIGINT       NOT NULL REFERENCES bank_accounts(bank_account_id),

    -- AA consent artifact
    consent_handle        VARCHAR(500) NOT NULL UNIQUE, -- AA-generated consent handle
    consent_status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                          CHECK (consent_status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'PAUSED')),

    fi_data_range_from    DATE         NOT NULL,
    fi_data_range_to      DATE         NOT NULL,

    -- Consent lifecycle
    consent_granted_at    TIMESTAMPTZ  NOT NULL,
    consent_expires_at    TIMESTAMPTZ,
    consent_revoked_at    TIMESTAMPTZ,

    -- AA metadata
    fip_id                VARCHAR(50)  NOT NULL,       -- bank identifier
    fi_types              TEXT[] NOT NULL DEFAULT '{"DEPOSIT"}',  -- types of financial info

    -- Refresh tracking
    last_fetch_at         TIMESTAMPTZ,
    last_fetch_success    BOOLEAN,

    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_aa_consents_company   ON aa_consents(company_id);
CREATE INDEX idx_aa_consents_handle    ON aa_consents(consent_handle);

-------------------------------------------------------------------------------
-- 4. RECONCILIATION RULES — Configurable matching rules per company
-------------------------------------------------------------------------------
CREATE TABLE reconciliation_rules (
    rule_id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id            BIGINT       NOT NULL,
    rule_name             VARCHAR(100) NOT NULL,

    -- Scoring weights (sum to 100 for proportional)
    amount_match_weight   INT NOT NULL DEFAULT 40,
    date_proximity_weight INT NOT NULL DEFAULT 30,
    reference_match_weight INT NOT NULL DEFAULT 30,
    description_match_weight INT NOT NULL DEFAULT 10,  -- bonus points

    -- Thresholds
    date_proximity_days   INT NOT NULL DEFAULT 3,       -- ± N days
    auto_match_threshold  NUMERIC(3,2) NOT NULL DEFAULT 0.70,
    suggest_match_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.50,

    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, rule_name)
);

-- Seed a default rule set
INSERT INTO reconciliation_rules (company_id, rule_name)
VALUES (1, 'Default Matching Rule');

-------------------------------------------------------------------------------
-- 5. AUTO-MATCH FUNCTION — Core matching logic in SQL
--    Called by the application layer after importing bank statements
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_reconcile_bank_entry(
    p_bank_statement_id  BIGINT,
    p_company_id         BIGINT
)
RETURNS TABLE (
    matched_entry_id    BIGINT,
    matched_txn_id      BIGINT,
    confidence          NUMERIC(3,2),
    rule_used           VARCHAR(50)
) AS $$
DECLARE
    v_bank               bank_statements%ROWTYPE;
    v_rules              reconciliation_rules%ROWTYPE;
    v_bank_amount        NUMERIC(18,2);
    v_is_debit           BOOLEAN;
    v_candidate          RECORD;
    v_best_confidence    NUMERIC(3,2) := 0;
    v_best_entry_id      BIGINT;
    v_best_txn_id        BIGINT;
    v_best_rule          VARCHAR(50);
    v_score              NUMERIC(3,2) := 0;
    v_date_diff          INT;
    v_desc_similarity    REAL;
BEGIN
    -- Load bank statement row
    SELECT * INTO v_bank
    FROM bank_statements
    WHERE bank_statement_id = p_bank_statement_id
      AND company_id        = p_company_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Load company's reconciliation rules
    SELECT * INTO v_rules
    FROM reconciliation_rules
    WHERE company_id = p_company_id AND is_active = TRUE
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Normalize bank amount as positive; determine direction
    IF v_bank.debit_amount > 0 THEN
        v_bank_amount := v_bank.debit_amount;
        v_is_debit    := TRUE;
    ELSE
        v_bank_amount := v_bank.credit_amount;
        v_is_debit    := FALSE;
    END IF;

    -- Search for matching journal entries within date window
    FOR v_candidate IN
        SELECT je.entry_id, je.transaction_id, je.debit_amount, je.credit_amount,
               t.txn_date, t.description AS txn_description, je.description AS je_description
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        JOIN bank_accounts ba ON ba.account_id = je.account_id
        WHERE ba.bank_account_id = v_bank.bank_account_id
          AND t.txn_date BETWEEN v_bank.transaction_date - v_rules.date_proximity_days
                             AND v_bank.transaction_date + v_rules.date_proximity_days
          -- Amount match (bank debit = journal credit, bank credit = journal debit)
          AND (
              (v_is_debit  AND je.credit_amount = v_bank_amount) OR
              (NOT v_is_debit AND je.debit_amount  = v_bank_amount)
          )
          AND t.company_id = p_company_id
    LOOP
        v_score := 0;

        -- ---- Rule 1: Amount match ----
        v_score := v_score + v_rules.amount_match_weight;
        v_best_rule := 'AMOUNT_EXACT';

        -- ---- Rule 2: Date proximity ----
        v_date_diff := ABS(v_bank.transaction_date - v_candidate.txn_date);
        CASE
            WHEN v_date_diff = 0 THEN v_score := v_score + v_rules.date_proximity_weight;
            WHEN v_date_diff = 1 THEN v_score := v_score + (v_rules.date_proximity_weight * 0.85)::INT;
            WHEN v_date_diff = 2 THEN v_score := v_score + (v_rules.date_proximity_weight * 0.70)::INT;
            WHEN v_date_diff = 3 THEN v_score := v_score + (v_rules.date_proximity_weight * 0.50)::INT;
            ELSE NULL;
        END CASE;

        -- ---- Rule 3: Reference number match ----
        IF v_bank.transaction_ref IS NOT NULL AND v_bank.transaction_ref <> '' THEN
            -- Check if reference appears in transaction metadata
            IF EXISTS (
                SELECT 1 FROM transactions t
                WHERE t.transaction_id = v_candidate.transaction_id
                  AND t.metadata->>'reference_number' = v_bank.transaction_ref
            ) THEN
                v_score := v_score + v_rules.reference_match_weight;
                v_best_rule := v_best_rule || '+REF_EXACT';
            -- Partial match: last 6 chars
            ELSIF LENGTH(v_bank.transaction_ref) >= 6
              AND EXISTS (
                SELECT 1 FROM transactions t
                WHERE t.transaction_id = v_candidate.transaction_id
                  AND t.metadata->>'reference_number' LIKE '%' || RIGHT(v_bank.transaction_ref, 6) || '%'
            ) THEN
                v_score := v_score + (v_rules.reference_match_weight * 0.5)::INT;
                v_best_rule := v_best_rule || '+REF_PARTIAL';
            END IF;
        END IF;

        -- ---- Rule 4: Description fuzzy match (bonus) ----
        v_desc_similarity := similarity(v_bank.description, v_candidate.txn_description);
        IF v_desc_similarity > 0.6 THEN
            v_score := v_score + (v_rules.description_match_weight * v_desc_similarity)::INT;
            v_best_rule := v_best_rule || '+DESC_FUZZY';
        END IF;

        -- Normalize score to 0.00–1.00 (total_weight sum may differ per rule config)
        -- Keep raw score; threshold comparison uses percentage of max possible

        IF v_score > v_best_confidence THEN
            v_best_confidence := v_score / 100.0;  -- normalize
            v_best_entry_id   := v_candidate.entry_id;
            v_best_txn_id     := v_candidate.transaction_id;
        END IF;
    END LOOP;

    -- Apply thresholds and update the bank statement
    IF v_best_confidence >= v_rules.auto_match_threshold THEN
        UPDATE bank_statements
        SET reconciliation_status = 'MATCHED',
            matched_journal_entry_id = v_best_entry_id,
            matched_transaction_id   = v_best_txn_id,
            match_confidence         = v_best_confidence,
            match_rule               = v_best_rule
        WHERE bank_statement_id = p_bank_statement_id;

    ELSIF v_best_confidence >= v_rules.suggest_match_threshold THEN
        UPDATE bank_statements
        SET reconciliation_status = 'SUGGESTED',
            matched_journal_entry_id = v_best_entry_id,
            matched_transaction_id   = v_best_txn_id,
            match_confidence         = v_best_confidence,
            match_rule               = v_best_rule
        WHERE bank_statement_id = p_bank_statement_id;

    ELSE
        UPDATE bank_statements
        SET reconciliation_status = 'UNRECONCILED'
        WHERE bank_statement_id = p_bank_statement_id;
    END IF;

    -- Return result
    RETURN QUERY
    SELECT v_best_entry_id, v_best_txn_id, v_best_confidence, v_best_rule;
END;
$$ LANGUAGE plpgsql STABLE;
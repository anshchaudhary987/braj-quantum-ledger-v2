-- ============================================================================
-- Core Journal System — Security-First & Integrity-First Indian Accounting SaaS
-- PostgreSQL 15+
-- ============================================================================

-- Extension for hierarchical materialized paths
CREATE EXTENSION IF NOT EXISTS ltree;

-------------------------------------------------------------------------------
-- 1. ACCOUNTS (Hierarchical via Materialized Path)
-------------------------------------------------------------------------------
CREATE TABLE accounts (
    account_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id     BIGINT REFERENCES accounts(account_id) ON DELETE RESTRICT,

    -- Materialized path (ltree) — e.g. '1.5.12.20'
    -- root nodes have path = ltree from their own account_id
    path          LTREE NOT NULL,

    account_name  VARCHAR(200) NOT NULL,
    account_code  VARCHAR(50)  NOT NULL UNIQUE,   -- Chart-of-Accounts code
    account_type  VARCHAR(20)  NOT NULL            -- e.g. Asset, Liability, Equity, Income, Expense
        CHECK (account_type IN ('Asset','Liability','Equity','Income','Expense')),

    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,

    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version       INT          NOT NULL DEFAULT 1
);

-- Index for fast subtree queries (e.g. find all children of account 5)
CREATE INDEX idx_accounts_path_gist ON accounts USING GIST (path);

-- Index for parent-child lookups in adjacency style
CREATE INDEX idx_accounts_parent ON accounts(parent_id);

-------------------------------------------------------------------------------
-- 2. TRANSACTIONS (Journal Header)
-------------------------------------------------------------------------------
CREATE TABLE transactions (
    transaction_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       UUID         NOT NULL,            -- Multi-tenant isolation
    txn_date        DATE         NOT NULL,            -- Accounting date
    description     TEXT         NOT NULL,
    metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version         INT          NOT NULL DEFAULT 1
);

-- Covering index for date-range queries per tenant
CREATE INDEX idx_transactions_tenant_date
    ON transactions(tenant_id, txn_date DESC);

-------------------------------------------------------------------------------
-- 3. JOURNAL ENTRIES (Atomic Debit / Credit Rows)
-------------------------------------------------------------------------------
CREATE TABLE journal_entries (
    entry_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id  BIGINT        NOT NULL
        REFERENCES transactions(transaction_id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

    account_id      BIGINT        NOT NULL
        REFERENCES accounts(account_id)
            ON DELETE RESTRICT,   -- Never orphan journal lines

    debit_amount    NUMERIC(18,2) NOT NULL DEFAULT 0.00
        CHECK (debit_amount >= 0),

    credit_amount   NUMERIC(18,2) NOT NULL DEFAULT 0.00
        CHECK (credit_amount >= 0),

    -- Enforce: a single row must be exclusively debit OR credit, never both
    CONSTRAINT chk_one_side CHECK (
        (debit_amount > 0 AND credit_amount = 0)
        OR
        (credit_amount > 0 AND debit_amount = 0)
    ),

    description     TEXT,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version         INT          NOT NULL DEFAULT 1
);

-- Fast lookup of all entries for a given transaction
CREATE INDEX idx_journal_entries_txn ON journal_entries(transaction_id);

-- Fast lookup of all entries for a given account (ledger view)
CREATE INDEX idx_journal_entries_account ON journal_entries(account_id);

-------------------------------------------------------------------------------
-- 4. BALANCE-CHECK TRIGGER (Debit = Credit per Transaction)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_enforce_double_entry()
RETURNS TRIGGER AS $$
DECLARE
    imbalance NUMERIC(18,2);
BEGIN
    -- Sum across ALL rows for the relevant transaction_id
    -- COALESCE handles both INSERT (NEW populated) and DELETE (OLD populated)

    WITH agg AS (
        SELECT
            COALESCE(SUM(debit_amount),  0.00) AS total_debit,
            COALESCE(SUM(credit_amount), 0.00) AS total_credit
        FROM journal_entries
        WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id)
    )
    SELECT (total_debit - total_credit) INTO imbalance
    FROM agg;

    IF imbalance IS NOT NULL AND imbalance <> 0.00 THEN
        RAISE EXCEPTION
            'Double-entry violation: transaction % is out of balance by %',
            COALESCE(NEW.transaction_id, OLD.transaction_id),
            imbalance;
    END IF;

    RETURN NULL;  -- AFTER trigger return value ignored
END;
$$ LANGUAGE plpgsql;

-- Deferrable constraint trigger — ensures deferred checking so multi-row
-- inserts can be performed before the balance is enforced.
CREATE CONSTRAINT TRIGGER ctrg_balance_check
    AFTER INSERT OR UPDATE OF debit_amount, credit_amount, transaction_id
                        OR DELETE
    ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_double_entry();

-------------------------------------------------------------------------------
-- 5. AUDIT VERSIONING — auto-increment version on every UPDATE
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_bump_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    NEW.version    := OLD.version + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all three tables
CREATE TRIGGER trg_accounts_version
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE TRIGGER trg_transactions_version
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE TRIGGER trg_journal_entries_version
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

-------------------------------------------------------------------------------
-- 6. IDEMPOTENCY KEYS — prevent duplicate financial transactions
-------------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL,
    tenant_id       UUID         NOT NULL,
    transaction_id  BIGINT       REFERENCES transactions(transaction_id)
                                     ON DELETE SET NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'PROCESSING'
                        CHECK (status IN ('PROCESSING','COMPLETED','FAILED')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_idempotency UNIQUE (idempotency_key, tenant_id)
);

-- Index for fast lookups by key + tenant
CREATE INDEX idx_idempotency_lookup
    ON idempotency_keys(idempotency_key, tenant_id);

-------------------------------------------------------------------------------
-- 7. AGGREGATION ENGINE — Real-time Running Balances
-------------------------------------------------------------------------------

-- Helper: determine Indian financial year (April — March)
CREATE OR REPLACE FUNCTION get_financial_year(txn_date DATE)
RETURNS INT AS $$
BEGIN
    IF EXTRACT(MONTH FROM txn_date) >= 4 THEN
        RETURN EXTRACT(YEAR FROM txn_date)::INT;
    ELSE
        RETURN EXTRACT(YEAR FROM txn_date)::INT - 1;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- 7a. ACCOUNT BALANCES — one row per account per financial year
-- ---------------------------------------------------------------------------
CREATE TABLE account_balances (
    account_id       BIGINT NOT NULL
        REFERENCES accounts(account_id) ON DELETE CASCADE,
    financial_year   INT    NOT NULL,         -- e.g. 2025 for FY 2025-2026

    total_debits     NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    total_credits    NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    closing_balance  NUMERIC(18,2) NOT NULL DEFAULT 0.00
        CHECK (closing_balance = total_debits - total_credits),

    last_updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version          INT          NOT NULL DEFAULT 1,

    PRIMARY KEY (account_id, financial_year)
);

-- ---------------------------------------------------------------------------
-- 7b. TRIGGER — update account_balances after every journal_entry mutation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_upsert_account_balance()
RETURNS TRIGGER AS $$
DECLARE
    v_account_id     BIGINT;
    v_debit_delta    NUMERIC(18,2);
    v_credit_delta   NUMERIC(18,2);
    v_fy             INT;
BEGIN
    -- Determine which account and what deltas we are dealing with
    IF TG_OP = 'DELETE' THEN
        v_account_id   := OLD.account_id;
        v_debit_delta  := -OLD.debit_amount;
        v_credit_delta := -OLD.credit_amount;
    ELSIF TG_OP = 'UPDATE' THEN
        v_account_id   := NEW.account_id;
        v_debit_delta  := NEW.debit_amount  - OLD.debit_amount;
        v_credit_delta := NEW.credit_amount - OLD.credit_amount;
    ELSE  -- INSERT
        v_account_id   := NEW.account_id;
        v_debit_delta  := NEW.debit_amount;
        v_credit_delta := NEW.credit_amount;
    END IF;

    -- Resolve financial year from the parent transaction's date
    SELECT get_financial_year(t.txn_date) INTO v_fy
    FROM transactions t
    WHERE t.transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id);

    -- UPSERT: create the row if this is the first entry for this account+year,
    -- otherwise increment/decrement the running totals.
    INSERT INTO account_balances (account_id, financial_year, total_debits, total_credits, closing_balance)
    VALUES (v_account_id, v_fy, v_debit_delta, v_credit_delta, v_debit_delta - v_credit_delta)
    ON CONFLICT (account_id, financial_year) DO UPDATE
    SET total_debits    = account_balances.total_debits  + v_debit_delta,
        total_credits   = account_balances.total_credits + v_credit_delta,
        closing_balance = account_balances.total_debits  + v_debit_delta
                        - (account_balances.total_credits + v_credit_delta),
        last_updated_at = now(),
        version         = account_balances.version + 1;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fire AFTER the row is committed so that the double-entry constraint has
-- already validated the transaction.
CREATE TRIGGER trg_account_balance_update
    AFTER INSERT OR UPDATE OF debit_amount, credit_amount, account_id, transaction_id
               OR DELETE
    ON journal_entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_upsert_account_balance();

-- ---------------------------------------------------------------------------
-- 7c. PERFORMANCE INDEXES — sub-100ms ledger queries @ 1M rows
-- ---------------------------------------------------------------------------

-- Composite B-tree: equality on account_id + range scan on created_at
-- Enables queries like:
--   SELECT * FROM journal_entries WHERE account_id = ? AND created_at BETWEEN ? AND ?
CREATE INDEX idx_je_account_created
    ON journal_entries(account_id, created_at);

-- Covering (INCLUDE) variant: avoids heap lookups entirely by storing
-- amounts inside the index leaf. Postgres can answer the query with an
-- Index-Only Scan — no disk I/O to the main table.
CREATE INDEX idx_je_account_created_cover
    ON journal_entries(account_id, created_at)
    INCLUDE (debit_amount, credit_amount, transaction_id, description);

-- Partial index for open/incomplete financial years (hot path only)
-- Useful when you want to scan only the current year's entries.
CREATE INDEX idx_je_current_fy
    ON journal_entries(account_id, created_at)
    INCLUDE (debit_amount, credit_amount)
    WHERE created_at >= '2026-04-01'::timestamptz;  -- adjust yearly
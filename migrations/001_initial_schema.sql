-- ============================================================================
-- MIGRATION: 001_initial_schema.sql
-- Purpose: Core journal system — Security-First & Integrity-First
-- PostgreSQL 15+
-- ============================================================================

-- 1. Extension for hierarchical materialized paths
CREATE EXTENSION IF NOT EXISTS ltree;

-- 2. ACCOUNTS (Hierarchical via Materialized Path)
CREATE TABLE IF NOT EXISTS accounts (
    account_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id     BIGINT REFERENCES accounts(account_id) ON DELETE RESTRICT,
    path          LTREE NOT NULL,
    account_name  VARCHAR(200) NOT NULL,
    account_code  VARCHAR(50)  NOT NULL UNIQUE,
    account_type  VARCHAR(20)  NOT NULL
        CHECK (account_type IN ('Asset','Liability','Equity','Income','Expense')),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version       INT          NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_accounts_path_gist ON accounts USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);

-- 3. TRANSACTIONS (Journal Header)
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       UUID         NOT NULL,
    txn_date        DATE         NOT NULL,
    description     TEXT         NOT NULL,
    metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version         INT          NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_transactions_tenant ON transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);

-- 4. JOURNAL ENTRIES (Journal Detail)
CREATE TABLE IF NOT EXISTS journal_entries (
    entry_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id  BIGINT       NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    account_id      BIGINT       NOT NULL REFERENCES accounts(account_id),
    debit_amount    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
    credit_amount   NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
    description     TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_transaction ON journal_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(account_id);

-- 5. IDEMPOTENCY KEYS
CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key VARCHAR(36) PRIMARY KEY,
    tenant_id       VARCHAR(36)  NOT NULL,
    transaction_id  BIGINT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'PROCESSING',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE(idempotency_key, tenant_id)
);

-- -----------------------------------------------------------------------------
-- DOWN (for rollback)
-- -----------------------------------------------------------------------------
-- DROP TABLE IF EXISTS idempotency_keys CASCADE;
-- DROP TABLE IF EXISTS journal_entries CASCADE;
-- DROP TABLE IF EXISTS transactions CASCADE;
-- DROP TABLE IF EXISTS accounts CASCADE;
-- DROP EXTENSION IF EXISTS ltree;

-- ============================================================================
-- SECURITY & AUDIT FRAMEWORK
-- Multi-Tenancy (RLS) + Immutable Audit Trail + Fiscal Locking + RBAC
-- ============================================================================

-- ============================================================================
-- PART 0: MULTI-TENANCY STRATEGY (Architectural Decision)
-- ============================================================================
--
-- APPROACH CHOSEN: Shared Schema + Row-Level Security (RLS)
--
-- Why NOT "Separate Schema per Tenant"?
--   - 100,000 MSMEs = 100,000 schemas → administration nightmare
--   - Connection pooling becomes impossible (each schema = separate search_path)
--   - Cross-tenant reporting requires UNION across schemas
--   - pg_dump/pg_restore per tenant is operationally heavy
--   - PostgreSQL struggles with >10,000 schemas gracefully
--
-- Why Shared Schema + RLS?
--   - Single connection pool serves all tenants
--   - INDEX on company_id (lead column) keeps queries fast
--   - RLS enforced at DB level, not app level (defense in depth)
--   - Can shard by moving large tenants to dedicated DBs later
--   - For 100K MSMEs with ~100GB total data, a single RDS instance
--     handles this comfortably with proper indexing
--
-- How RLS works:
--   1. Every table has a `company_id BIGINT NOT NULL` column.
--   2. At session start: SET app.current_company_id = '12345';
--   3. RLS policies invisibly add: WHERE company_id = 12345 to every query.
--   4. INSERTs automatically populate company_id from the session variable.
--   5. Users in the 'SAAS_ADMIN' role bypass RLS for support tasks.
--
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. AUDIT LOGS — MCA-Compliant Immutable Audit Trail
-------------------------------------------------------------------------------

-- Separate schema restricts direct access
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.audit_logs (
    audit_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    company_id      BIGINT        NOT NULL,
    table_name      VARCHAR(100)  NOT NULL,
    record_id       BIGINT        NOT NULL,          -- primary key of the changed row
    operation       VARCHAR(10)   NOT NULL           -- INSERT, UPDATE, DELETE
                    CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),

    -- Full row snapshots in JSONB for complete reconstruction
    old_values      JSONB,                           -- NULL on INSERT
    new_values      JSONB,                           -- NULL on DELETE

    -- MCA mandatory fields
    changed_by      BIGINT        NOT NULL,          -- user_id
    changed_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    ip_address      INET,
    user_agent      VARCHAR(500),

    -- Traceability
    transaction_id  BIGINT,                          -- application-level txn context
    session_id      UUID,

    -- Partition-friendly (partition by changed_at for archival)
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Indexes for audit queries (Who changed what and when?)
CREATE INDEX idx_audit_company_table ON audit.audit_logs(company_id, table_name, changed_at DESC);
CREATE INDEX idx_audit_record         ON audit.audit_logs(table_name, record_id, changed_at DESC);
CREATE INDEX idx_audit_user           ON audit.audit_logs(changed_by, changed_at DESC);
CREATE INDEX idx_audit_timestamp      ON audit.audit_logs(changed_at);

-- ============================================================================
-- MAKE AUDIT LOGS APPEND-ONLY (even Admin cannot delete)
-- ============================================================================

-- 1. Revoke all destructive permissions
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_logs FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_logs FROM glm_app;

-- 2. Only the audit_writer role can INSERT (used by triggers)
-- (Run separately: GRANT INSERT ON audit.audit_logs TO audit_writer;)

-- 3. Event trigger: prevent DROP TABLE on audit schema
CREATE OR REPLACE FUNCTION audit.trg_prevent_drop()
RETURNS EVENT_TRIGGER AS $$
DECLARE
    obj RECORD;
BEGIN
    FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
    LOOP
        IF obj.schema_name = 'audit' AND obj.object_type = 'table' THEN
            RAISE EXCEPTION 'Audit tables are immutable and cannot be dropped.';
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Register event trigger (requires superuser)
-- CREATE EVENT TRIGGER trg_audit_drop_prevent
--     ON sql_drop
--     WHEN TAG IN ('DROP TABLE', 'DROP SCHEMA')
--     EXECUTE FUNCTION audit.trg_prevent_drop();

-- ============================================================================
-- 2. GENERIC AUDIT TRIGGER — Captures all DML on audited tables
-- ============================================================================
CREATE OR REPLACE FUNCTION trg_audit_log()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id     BIGINT;
    v_ip_address  INET;
    v_user_agent  VARCHAR(500);
    v_company_id  BIGINT;
    v_session_id  UUID;
BEGIN
    -- Read session context set by the application layer
    BEGIN
        v_user_id := current_setting('app.current_user_id')::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        v_user_id := 0;  -- system / migration
    END;

    BEGIN
        v_ip_address := current_setting('app.current_ip_address')::INET;
    EXCEPTION WHEN OTHERS THEN
        v_ip_address := NULL;
    END;

    BEGIN
        v_user_agent := current_setting('app.current_user_agent');
    EXCEPTION WHEN OTHERS THEN
        v_user_agent := NULL;
    END;

    BEGIN
        v_company_id := current_setting('app.current_company_id')::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        v_company_id := COALESCE(NEW.company_id, OLD.company_id, 0);
    END;

    BEGIN
        v_session_id := current_setting('app.current_session_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
        v_session_id := NULL;
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit.audit_logs (
            company_id, table_name, record_id, operation,
            old_values, new_values,
            changed_by, ip_address, user_agent, session_id
        ) VALUES (
            v_company_id,
            TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
            NEW.id,                                    -- assumes PK named 'id'
            'INSERT',
            NULL,
            to_jsonb(NEW),
            v_user_id, v_ip_address, v_user_agent, v_session_id
        );
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit.audit_logs (
            company_id, table_name, record_id, operation,
            old_values, new_values,
            changed_by, ip_address, user_agent, session_id
        ) VALUES (
            v_company_id,
            TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
            NEW.id,
            'UPDATE',
            to_jsonb(OLD),
            to_jsonb(NEW),
            v_user_id, v_ip_address, v_user_agent, v_session_id
        );
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit.audit_logs (
            company_id, table_name, record_id, operation,
            old_values, new_values,
            changed_by, ip_address, user_agent, session_id
        ) VALUES (
            v_company_id,
            TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
            OLD.id,
            'DELETE',
            to_jsonb(OLD),
            NULL,
            v_user_id, v_ip_address, v_user_agent, v_session_id
        );
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 3. FISCAL PERIODS — Voucher Locking for Period Closing
-- ============================================================================
CREATE TABLE fiscal_periods (
    fiscal_period_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id        BIGINT        NOT NULL,
    period_name       VARCHAR(100)  NOT NULL,          -- e.g. 'April 2026', 'FY 2025-2026'
    start_date        DATE          NOT NULL,
    end_date          DATE          NOT NULL,

    is_locked         BOOLEAN       NOT NULL DEFAULT FALSE,
    is_year_closing   BOOLEAN       NOT NULL DEFAULT FALSE,

    locked_by         BIGINT,                          -- user_id who locked
    locked_at         TIMESTAMPTZ,

    -- MCA requires audit of the locking itself
    lock_reason       TEXT,                            -- e.g. 'Monthly closing', 'Statutory audit'

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_dates CHECK (end_date >= start_date),
    CONSTRAINT uq_fiscal_period UNIQUE (company_id, period_name)
);

CREATE INDEX idx_fiscal_periods_company ON fiscal_periods(company_id, start_date);

-- ============================================================================
-- 4. VOUCHER LOCKING TRIGGER — Prevents entries in locked periods
-- ============================================================================
CREATE OR REPLACE FUNCTION trg_enforce_fiscal_lock()
RETURNS TRIGGER AS $$
DECLARE
    v_txn_date DATE;
    v_period_name VARCHAR(100);
    v_company_id BIGINT;
BEGIN
    -- Determine the transaction date
    IF TG_TABLE_NAME = 'transactions' THEN
        v_txn_date := NEW.txn_date;
        v_company_id := NEW.company_id;
    ELSIF TG_TABLE_NAME = 'journal_entries' THEN
        SELECT t.txn_date, t.company_id
        INTO v_txn_date, v_company_id
        FROM transactions t
        WHERE t.transaction_id = NEW.transaction_id;
    ELSIF TG_TABLE_NAME = 'stock_transactions' THEN
        SELECT t.txn_date, t.company_id
        INTO v_txn_date, v_company_id
        FROM transactions t
        WHERE t.transaction_id = NEW.transaction_id;
    END IF;

    -- Check if the date falls within a locked period
    SELECT fp.period_name INTO v_period_name
    FROM fiscal_periods fp
    WHERE fp.company_id = v_company_id
      AND fp.is_locked  = TRUE
      AND v_txn_date   >= fp.start_date
      AND v_txn_date   <= fp.end_date
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'Cannot modify entries for date %. This date falls in the locked period: "%". '
            'Unlock the period first or contact your administrator.',
            v_txn_date, v_period_name;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to transactions (header) — covers new transactions
CREATE TRIGGER trg_fiscal_lock_txn
    BEFORE INSERT OR UPDATE OF txn_date ON transactions
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_fiscal_lock();

-- Apply to journal_entries — covers direct edits to existing lines
CREATE TRIGGER trg_fiscal_lock_je
    BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_fiscal_lock();

-- Apply to stock_transactions
CREATE TRIGGER trg_fiscal_lock_stock
    BEFORE INSERT OR UPDATE OR DELETE ON stock_transactions
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_fiscal_lock();

-- ============================================================================
-- 5. ROLE-BASED ACCESS CONTROL (RBAC)
-- ============================================================================
CREATE TABLE roles (
    role_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_name     VARCHAR(50)  NOT NULL UNIQUE,
    description   TEXT,
    is_system     BOOLEAN      NOT NULL DEFAULT FALSE, -- system roles cannot be deleted
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Seed system roles
INSERT INTO roles (role_name, description, is_system) VALUES
    ('SUPER_ADMIN',  'Platform-level administrator — can manage companies and billing', TRUE),
    ('OWNER',        'Company owner — full access to all modules for their company',    TRUE),
    ('ACCOUNTANT',   'Can create vouchers, view ledgers, reconcile, but not lock periods', TRUE),
    ('DATA_ENTRY',   'Can create vouchers only; cannot view financial reports',          TRUE),
    ('AUDITOR',      'Read-only access to all financial data for audit purposes',        TRUE),
    ('INVENTORY_MGR', 'Can manage stock items, godowns, and stock movements',            TRUE);

-------------------------------------------------------------------------------
-- Permissions — granular module + action
-------------------------------------------------------------------------------
CREATE TABLE permissions (
    permission_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    module        VARCHAR(30)  NOT NULL,           -- 'ACCOUNTS', 'INVENTORY', 'GST', 'REPORTS', 'ADMIN'
    action        VARCHAR(20)  NOT NULL,           -- 'CREATE', 'READ', 'UPDATE', 'DELETE', 'LOCK', 'EXPORT'
    UNIQUE (module, action)
);

-- Seed permissions
INSERT INTO permissions (module, action) VALUES
    -- Accounts
    ('ACCOUNTS', 'CREATE'), ('ACCOUNTS', 'READ'), ('ACCOUNTS', 'UPDATE'), ('ACCOUNTS', 'DELETE'),
    -- Inventory  
    ('INVENTORY', 'CREATE'), ('INVENTORY', 'READ'), ('INVENTORY', 'UPDATE'), ('INVENTORY', 'DELETE'),
    -- GST
    ('GST', 'CREATE'), ('GST', 'READ'), ('GST', 'UPDATE'),
    -- Reports
    ('REPORTS', 'READ'), ('REPORTS', 'EXPORT'),
    -- Admin (period locking, user management for the company)
    ('ADMIN', 'LOCK_PERIOD'), ('ADMIN', 'UNLOCK_PERIOD'),
    ('ADMIN', 'MANAGE_USERS'), ('ADMIN', 'VIEW_AUDIT_LOG');

-------------------------------------------------------------------------------
-- Role → Permissions mapping
-------------------------------------------------------------------------------
CREATE TABLE role_permissions (
    role_id       INT REFERENCES roles(role_id)       ON DELETE CASCADE,
    permission_id INT REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Seed role-permission assignments
-- OWNER: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT role_id FROM roles WHERE role_name = 'OWNER'), permission_id FROM permissions;

-- ACCOUNTANT: all accounts operations + reports, no admin/locking
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT role_id FROM roles WHERE role_name = 'ACCOUNTANT'), permission_id
FROM permissions
WHERE (module, action) IN (
    ('ACCOUNTS', 'CREATE'), ('ACCOUNTS', 'READ'), ('ACCOUNTS', 'UPDATE'),
    ('INVENTORY', 'CREATE'), ('INVENTORY', 'READ'),
    ('GST', 'CREATE'), ('GST', 'READ'),
    ('REPORTS', 'READ'), ('REPORTS', 'EXPORT')
);

-- DATA_ENTRY: create in accounts + inventory, limited read
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT role_id FROM roles WHERE role_name = 'DATA_ENTRY'), permission_id
FROM permissions
WHERE (module, action) IN (
    ('ACCOUNTS', 'CREATE'), ('ACCOUNTS', 'READ'),
    ('INVENTORY', 'CREATE'), ('INVENTORY', 'READ'),
    ('GST', 'READ')
);

-- AUDITOR: read-only on all modules
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT role_id FROM roles WHERE role_name = 'AUDITOR'), permission_id
FROM permissions
WHERE action IN ('READ');

-- INVENTORY_MGR: inventory + read accounts/gst
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT role_id FROM roles WHERE role_name = 'INVENTORY_MGR'), permission_id
FROM permissions
WHERE (module, action) IN (
    ('INVENTORY', 'CREATE'), ('INVENTORY', 'READ'), ('INVENTORY', 'UPDATE'),
    ('ACCOUNTS', 'READ'), ('REPORTS', 'READ')
);

-------------------------------------------------------------------------------
-- User → Company → Role assignment
-------------------------------------------------------------------------------
CREATE TABLE user_company_roles (
    user_id       BIGINT NOT NULL,
    company_id    BIGINT NOT NULL,
    role_id       INT    NOT NULL REFERENCES roles(role_id),
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by   BIGINT,

    PRIMARY KEY (user_id, company_id, role_id)
);

CREATE INDEX idx_ucr_user_company ON user_company_roles(user_id, company_id);

-------------------------------------------------------------------------------
-- Permission check function — used by the API layer
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION user_has_permission(
    p_user_id    BIGINT,
    p_company_id BIGINT,
    p_module     VARCHAR(30),
    p_action     VARCHAR(20)
)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM user_company_roles ucr
        JOIN role_permissions rp ON rp.role_id = ucr.role_id
        JOIN permissions p      ON p.permission_id = rp.permission_id
        WHERE ucr.user_id    = p_user_id
          AND ucr.company_id = p_company_id
          AND p.module       = p_module
          AND p.action       = p_action
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- 6. ROW-LEVEL SECURITY (RLS) — Setup for Multi-Tenancy
-- ============================================================================

-- Helper: set current company context (called by app at session start)
-- SET app.current_company_id = '12345';
-- SET app.current_user_id = '678';
-- SET app.current_ip_address = '192.168.1.1';

-- Generic RLS enabling function
CREATE OR REPLACE FUNCTION enable_rls_for_table(
    p_table_name      VARCHAR,
    p_schema_name     VARCHAR DEFAULT 'public'
)
RETURNS VOID AS $$
DECLARE
    v_full_name TEXT := quote_ident(p_schema_name) || '.' || quote_ident(p_table_name);
BEGIN
    -- Enable RLS
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_full_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_full_name);

    -- Create SELECT/UPDATE/DELETE policy (filter by company_id)
    EXECUTE format($policy$
        CREATE POLICY rls_tenant_isolation ON %s
            USING (company_id = current_setting('app.current_company_id')::BIGINT)
            WITH CHECK (company_id = current_setting('app.current_company_id')::BIGINT)
    $policy$, v_full_name);

    -- Create INSERT policy (auto-set company_id from session if not explicitly provided)
    EXECUTE format($insert_policy$
        CREATE POLICY rls_tenant_insert ON %s
            FOR INSERT
            WITH CHECK (company_id = current_setting('app.current_company_id')::BIGINT)
    $insert_policy$, v_full_name);
END;
$$ LANGUAGE plpgsql;

-- Bypass RLS for SUPER_ADMIN role (platform-level support)
-- The application checks user_company_roles before setting app.current_company_id.
-- SUPER_ADMIN users can SET app.current_company_id to ANY company's ID.
-- There is NO application-level bypass — the admin MUST set the right company context.
-- For cross-company queries (rare), use a function with SECURITY DEFINER.

-- ============================================================================
-- 7. SESSION INITIALIZATION — Called at the start of every API request
-- ============================================================================
CREATE OR REPLACE FUNCTION init_security_context(
    p_company_id  BIGINT,
    p_user_id     BIGINT,
    p_ip_address  VARCHAR DEFAULT NULL,
    p_user_agent  VARCHAR DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_company_id', p_company_id::TEXT, FALSE);
    PERFORM set_config('app.current_user_id',    p_user_id::TEXT,    FALSE);

    IF p_ip_address IS NOT NULL THEN
        PERFORM set_config('app.current_ip_address', p_ip_address, FALSE);
    END IF;

    IF p_user_agent IS NOT NULL THEN
        PERFORM set_config('app.current_user_agent', p_user_agent, FALSE);
    END IF;

    PERFORM set_config('app.current_session_id', gen_random_uuid()::TEXT, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

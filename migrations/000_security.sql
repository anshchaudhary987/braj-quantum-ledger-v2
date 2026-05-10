-- ============================================================================
-- SECURITY & AUDIT FRAMEWORK
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.audit_logs (
    audit_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT        NOT NULL,
    table_name      VARCHAR(100)  NOT NULL,
    record_id       BIGINT        NOT NULL,
    operation       VARCHAR(10)   NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    old_values      JSONB,
    new_values      JSONB,
    changed_by      BIGINT        NOT NULL,
    changed_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    ip_address      INET,
    user_agent      VARCHAR(500),
    transaction_id  BIGINT,
    session_id      UUID,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    role_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_name     VARCHAR(50)  NOT NULL UNIQUE,
    description   TEXT,
    is_system     BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO roles (role_name, description, is_system) VALUES
    ('SUPER_ADMIN',  'Platform-level administrator', TRUE),
    ('OWNER',        'Company owner',    TRUE),
    ('ACCOUNTANT',   'Can create vouchers', TRUE),
    ('DATA_ENTRY',   'Can create vouchers only', TRUE),
    ('AUDITOR',      'Read-only access', TRUE),
    ('INVENTORY_MGR', 'Inventory management', TRUE)
ON CONFLICT (role_name) DO NOTHING;

CREATE TABLE permissions (
    permission_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    module        VARCHAR(30)  NOT NULL,
    action        VARCHAR(20)  NOT NULL,
    UNIQUE (module, action)
);

INSERT INTO permissions (module, action) VALUES
    ('ACCOUNTS', 'CREATE'), ('ACCOUNTS', 'READ'), ('ACCOUNTS', 'UPDATE'), ('ACCOUNTS', 'DELETE'),
    ('INVENTORY', 'CREATE'), ('INVENTORY', 'READ'), ('INVENTORY', 'UPDATE'), ('INVENTORY', 'DELETE'),
    ('GST', 'CREATE'), ('GST', 'READ'), ('GST', 'UPDATE'),
    ('REPORTS', 'READ'), ('REPORTS', 'EXPORT'),
    ('ADMIN', 'LOCK_PERIOD'), ('ADMIN', 'UNLOCK_PERIOD'),
    ('ADMIN', 'MANAGE_USERS'), ('ADMIN', 'VIEW_AUDIT_LOG')
ON CONFLICT DO NOTHING;

CREATE TABLE role_permissions (
    role_id       INT REFERENCES roles(role_id)       ON DELETE CASCADE,
    permission_id INT REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_company_roles (
    user_id       BIGINT NOT NULL,
    company_id    BIGINT NOT NULL,
    role_id       INT    NOT NULL REFERENCES roles(role_id),
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by   BIGINT,
    PRIMARY KEY (user_id, company_id, role_id)
);

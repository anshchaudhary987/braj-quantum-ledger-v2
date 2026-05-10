-- ============================================================================
-- MIGRATION: 002_user_registration_core.sql
-- Purpose: Define core users and companies tables and link them to roles
-- ============================================================================

-- 1. COMPANIES
CREATE TABLE IF NOT EXISTS companies (
    company_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_name    VARCHAR(200) NOT NULL,
    company_type    VARCHAR(50)  DEFAULT 'PROPRIETORSHIP',
    registration_no VARCHAR(50),
    fiscal_year_start DATE         NOT NULL DEFAULT '2026-04-01',
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 2. USERS
CREATE TABLE IF NOT EXISTS users (
    user_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(is_active);

-- 4. Foreign keys for user_company_roles (defined in security_schema.sql)
-- This section handles linking if the tables were created in separate scripts.
DO $$
BEGIN
    -- Check if user_company_roles exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_company_roles') THEN
        -- Add foreign keys if not already present
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_ucr_user') THEN
            ALTER TABLE user_company_roles ADD CONSTRAINT fk_ucr_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_ucr_company') THEN
            ALTER TABLE user_company_roles ADD CONSTRAINT fk_ucr_company FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE;
        END IF;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- DOWN
-- -----------------------------------------------------------------------------
-- DROP TABLE IF EXISTS users CASCADE;
-- DROP TABLE IF EXISTS companies CASCADE;

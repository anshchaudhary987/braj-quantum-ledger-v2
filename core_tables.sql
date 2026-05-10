-- ============================================================================
-- CORE TABLES — Users and Companies
-- ============================================================================

-- 1. COMPANIES
CREATE TABLE IF NOT EXISTS companies (
    company_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_name    VARCHAR(200) NOT NULL,
    company_type    VARCHAR(50),                     -- 'PROPRIETORSHIP', 'PARTNERSHIP', 'PVT_LTD', etc.
    registration_no VARCHAR(50),                     -- PAN/CIN
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

-- 3. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(is_active);

-- 4. Alter user_company_roles to add foreign keys (since it was created in security_schema.sql)
-- Note: This assumes security_schema.sql has been run.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_company_roles') THEN
        ALTER TABLE user_company_roles ADD CONSTRAINT fk_ucr_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
        ALTER TABLE user_company_roles ADD CONSTRAINT fk_ucr_company FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE;
    END IF;
END $$;

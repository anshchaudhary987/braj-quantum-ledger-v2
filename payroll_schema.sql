-- ============================================================================
-- INDIAN PAYROLL & HRMS ENGINE — Automated Salary + Statutory Deductions
-- PostgreSQL 15+  |  Cloud-Native Accounting Backend
-- ============================================================================
--
-- Statutory Coverage:
--   PF  — Employees' Provident Fund (12% of Basic+DA, wages capped at ₹15,000)
--   ESI — Employee State Insurance (0.75% employee, 3.25% employer, ≤ ₹21,000)
--   PT  — Professional Tax (state-specific slabs)
--   TDS — Income Tax Deduction at Source (Section 192 — Salary)
--
-- Auto-Journal: On payroll approval, the system generates:
--   Dr Salary Expense A/c       (Gross Salary + Employer PF + Employer ESI)
--   Dr Employer PF Contribution A/c
--   Dr Employer ESI Contribution A/c
--       Cr Salary Payable A/c          (Net pay to employees)
--       Cr EPF Payable A/c              (Employee PF + Employer PF)
--       Cr ESI Payable A/c              (Employee ESI + Employer ESI)
--       Cr Professional Tax Payable A/c
--       Cr TDS Payable A/c              (Income Tax)
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. ENUM TYPES
-------------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE employee_status AS ENUM (
        'ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE payroll_status AS ENUM (
        'DRAFT', 'COMPUTED', 'APPROVED', 'JOURNAL_POSTED', 'PAID', 'CANCELLED'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE pay_head_type AS ENUM ('EARNING', 'DEDUCTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE attendance_status AS ENUM (
        'PRESENT', 'ABSENT', 'HALF_DAY', 'PAID_LEAVE', 'UNPAID_LEAVE', 'WEEKLY_OFF', 'HOLIDAY'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE pf_applicability AS ENUM (
        'FULL',            -- PF applicable on actual Basic+DA
        'RESTRICTED',      -- PF applicable but wages capped at ₹15,000
        'EXCLUDED',        -- Employee opted out / wages > ₹15,000 (existing member)
        'EXEMPT'           -- Establishment exempt from PF Act
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE esi_applicability AS ENUM (
        'COVERED',         -- Gross wage ≤ ₹21,000 (or ₹25,000 for PWD)
        'EXCLUDED',        -- Gross wage > ceiling
        'EXEMPT'           -- Establishment exempt
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-------------------------------------------------------------------------------
-- 2. STATUTORY RATES MASTER
--    Centralised configuration for PF, ESI, PT, and tax slabs.
-------------------------------------------------------------------------------

CREATE TABLE statutory_rates (
    rate_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    component      VARCHAR(20)  NOT NULL,           -- 'PF', 'ESI', 'PT', 'INCOME_TAX'
    sub_component  VARCHAR(30),                     -- 'EMPLOYEE', 'EMPLOYER', 'SLAB_1', etc.
    rate_percent   NUMERIC(6,3),                    -- e.g. 12.000 for PF, 0.750 for ESI employee
    wage_floor     NUMERIC(18,2) DEFAULT 0,         -- minimum wage to qualify
    wage_ceiling   NUMERIC(18,2),                   -- PF: 15000, ESI: 21000
    state_code     VARCHAR(2)  REFERENCES state_master(state_code), -- for PT slabs
    slab_from      NUMERIC(18,2),                   -- for PT & IT slabs
    slab_to        NUMERIC(18,2),
    fixed_amount   NUMERIC(18,2),                   -- for PT: exact ₹ amount per month
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to   DATE,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT chk_statutory_component CHECK (component IN ('PF', 'ESI', 'PT', 'INCOME_TAX')),
    CONSTRAINT chk_statutory_amount CHECK (
        (fixed_amount IS NOT NULL AND rate_percent IS NULL) OR
        (rate_percent  IS NOT NULL AND fixed_amount IS NULL)
    )
);

-- Seed: PF rates (Employee: 12%, Employer: 12% — 3.67% PF + 8.33% EPS)
INSERT INTO statutory_rates (component, sub_component, rate_percent, wage_ceiling, fixed_amount, effective_from)
VALUES
    ('PF', 'EMPLOYEE_PF',      12.000, 15000, NULL, '2024-04-01'),
    ('PF', 'EMPLOYER_PF',       3.670, 15000, NULL, '2024-04-01'),
    ('PF', 'EMPLOYER_EPS',      8.330, 15000, NULL, '2024-04-01'),
    ('PF', 'ADMIN_CHARGES',     0.500, 15000, NULL, '2024-04-01'),
    ('PF', 'EDLI_CHARGES',      0.500, 15000, NULL, '2024-04-01')
ON CONFLICT DO NOTHING;

-- Seed: ESI rates
INSERT INTO statutory_rates (component, sub_component, rate_percent, wage_ceiling, fixed_amount, effective_from)
VALUES
    ('ESI', 'EMPLOYEE',   0.750, 21000, NULL, '2024-04-01'),
    ('ESI', 'EMPLOYER',   3.250, 21000, NULL, '2024-04-01')
ON CONFLICT DO NOTHING;

-- Seed: Professional Tax — Karnataka (KA) example
INSERT INTO statutory_rates (component, sub_component, state_code, slab_from, slab_to, fixed_amount, effective_from)
VALUES
    ('PT', 'SLAB_1', '29',      0,  14999,    0,   '2024-04-01'),
    ('PT', 'SLAB_2', '29',  15000,  24999,  150,   '2024-04-01'),
    ('PT', 'SLAB_3', '29',  25000, 99999999, 200,   '2024-04-01')
ON CONFLICT DO NOTHING;

-- Seed: Professional Tax — Maharashtra (MH) example
INSERT INTO statutory_rates (component, sub_component, state_code, slab_from, slab_to, fixed_amount, effective_from)
VALUES
    ('PT', 'SLAB_1', '27',      0,   7500,    0,   '2024-04-01'),
    ('PT', 'SLAB_2', '27',   7501,  10000,  175,   '2024-04-01'),
    ('PT', 'SLAB_3', '27',  10001, 99999999, 200,   '2024-04-01')
ON CONFLICT DO NOTHING;

-- (Additional state PT slabs can be added here: WB=19, TN=33, GJ=24, etc.)

-- Seed: Income Tax slabs (New Regime FY 2025-26 example)
INSERT INTO statutory_rates (component, sub_component, rate_percent, slab_from, slab_to, effective_from)
VALUES
    ('INCOME_TAX', 'SLAB_1',  0.000,       0,  400000, '2025-04-01'),
    ('INCOME_TAX', 'SLAB_2',  5.000,  400001,  800000, '2025-04-01'),
    ('INCOME_TAX', 'SLAB_3', 10.000,  800001, 1200000, '2025-04-01'),
    ('INCOME_TAX', 'SLAB_4', 15.000, 1200001, 1600000, '2025-04-01'),
    ('INCOME_TAX', 'SLAB_5', 20.000, 1600001, 2000000, '2025-04-01'),
    ('INCOME_TAX', 'SLAB_6', 25.000, 2000001, 2400000, '2025-04-01'),
    ('INCOME_TAX', 'SLAB_7', 30.000, 2400001, 9999999999, '2025-04-01')
ON CONFLICT DO NOTHING;

CREATE INDEX idx_statutory_component ON statutory_rates(component, is_active) WHERE is_active = TRUE;

-------------------------------------------------------------------------------
-- 3. EMPLOYEE MASTER
-------------------------------------------------------------------------------

CREATE TABLE employees (
    employee_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID         NOT NULL,

    -- Personal
    employee_code     VARCHAR(30)  NOT NULL,
    first_name        VARCHAR(100) NOT NULL,
    last_name         VARCHAR(100),
    date_of_birth     DATE,
    date_of_joining   DATE         NOT NULL,
    date_of_exit      DATE,
    gender            VARCHAR(1)   CHECK (gender IN ('M', 'F', 'O')),

    -- Statutory identifiers
    pan               VARCHAR(10),                           -- Permanent Account Number
    uan               VARCHAR(12),                           -- Universal Account Number (EPFO)
    pf_number         VARCHAR(25),                           -- local PF account number
    esi_ip_number     VARCHAR(17),                           -- ESI Insurance Person number
    pran              VARCHAR(12),                           -- Permanent Retirement Account Number (NPS)

    -- Work location (drives Professional Tax)
    work_location_state VARCHAR(2) REFERENCES state_master(state_code),

    -- Bank details for salary credit
    bank_account_number VARCHAR(34),
    bank_ifsc           VARCHAR(11),
    bank_name           VARCHAR(100),

    -- Link to general ledger (Employee as a party/creditor)
    employee_account_id BIGINT REFERENCES accounts(account_id),

    -- PF / ESI applicability at employee level
    pf_applicability  pf_applicability NOT NULL DEFAULT 'FULL',
    esi_applicability esi_applicability NOT NULL DEFAULT 'COVERED',
    is_eligible_for_pt BOOLEAN NOT NULL DEFAULT TRUE,

    -- TDS / IT declaration details
    tax_regime        VARCHAR(20) DEFAULT 'NEW',             -- 'OLD' or 'NEW'
    declared_investments NUMERIC(18,2) DEFAULT 0,            -- u/s 80C, 80D etc. (Old Regime)
    other_income      NUMERIC(18,2) DEFAULT 0,

    status            employee_status NOT NULL DEFAULT 'ACTIVE',
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INT NOT NULL DEFAULT 1,

    UNIQUE (tenant_id, employee_code)
);

CREATE INDEX idx_employee_status ON employees(tenant_id, status) WHERE status = 'ACTIVE';
CREATE INDEX idx_employee_pan ON employees(pan) WHERE pan IS NOT NULL;
CREATE INDEX idx_employee_uan ON employees(uan) WHERE uan IS NOT NULL;

-------------------------------------------------------------------------------
-- 4. SALARY STRUCTURES — Pay Head Configuration
--    Each employee has one active salary_structure at any time.
--    Changes are versioned by effective_from / effective_to.
-------------------------------------------------------------------------------

CREATE TABLE salary_structures (
    structure_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id       BIGINT       NOT NULL REFERENCES employees(employee_id),
    tenant_id         UUID         NOT NULL,

    component_name    VARCHAR(50)  NOT NULL,   -- 'BASIC', 'HRA', 'DA', 'CONVEYANCE', 'SPECIAL_ALLOWANCE'
    component_type    pay_head_type NOT NULL,   -- EARNING or DEDUCTION
    statutory_tag     VARCHAR(30),              -- 'PF_WAGE', 'ESI_WAGE', 'FULLY_TAXABLE', 'EXEMPT', 'REIMBURSEMENT'
    amount_or_percent NUMERIC(12,3),            -- if is_percentage: % of base wage; else: flat amount
    is_percentage     BOOLEAN NOT NULL DEFAULT FALSE,
    base_wage_ref     VARCHAR(30),              -- 'BASIC' — which component to calculate percentage on
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to      DATE,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_salary_emp_active ON salary_structures(employee_id)
    WHERE is_active = TRUE;

-- Ensure only one active structure per pay head per employee at a time
CREATE UNIQUE INDEX idx_unique_active_component
    ON salary_structures(employee_id, component_name)
    WHERE is_active = TRUE AND effective_to IS NULL;

-------------------------------------------------------------------------------
-- 5. PAY PERIODS — Monthly salary cycles
-------------------------------------------------------------------------------

CREATE TABLE pay_periods (
    pay_period_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID         NOT NULL,
    period_name       VARCHAR(20)  NOT NULL,         -- 'MAY-2026'
    period_start      DATE         NOT NULL,
    period_end        DATE         NOT NULL,
    working_days      INT          NOT NULL,          -- total working days in this period
    is_closed         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, period_name),
    CONSTRAINT chk_period_order CHECK (period_end >= period_start)
);

-------------------------------------------------------------------------------
-- 6. ATTENDANCE LOGS — Per-employee, per-day
-------------------------------------------------------------------------------

CREATE TABLE attendance_logs (
    attendance_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id       BIGINT       NOT NULL REFERENCES employees(employee_id),
    pay_period_id     BIGINT       NOT NULL REFERENCES pay_periods(pay_period_id),
    tenant_id         UUID         NOT NULL,

    attendance_date   DATE         NOT NULL,
    status            attendance_status NOT NULL DEFAULT 'PRESENT',
    hours_worked      NUMERIC(4,1),                    -- for half-day calculation: 4.0
    lop_days          NUMERIC(4,2) DEFAULT 0,          -- Loss of Pay days (0, 0.5, 1)
    remarks           VARCHAR(200),

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (employee_id, attendance_date)
);

CREATE INDEX idx_attendance_period ON attendance_logs(pay_period_id, employee_id);

-------------------------------------------------------------------------------
-- 7. PAYROLL RUNS — One row per monthly payroll run
-------------------------------------------------------------------------------

CREATE TABLE payroll_runs (
    payroll_run_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID         NOT NULL,
    pay_period_id     BIGINT       NOT NULL REFERENCES pay_periods(pay_period_id),

    run_description   VARCHAR(200) NOT NULL,          -- 'Salary for May 2026'
    run_date          DATE         NOT NULL DEFAULT CURRENT_DATE,
    payment_date      DATE,                             -- actual bank transfer date

    -- Aggregated totals (computed by the engine)
    total_gross_salary  NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_employer_pf   NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_employer_esi  NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_employee_pf   NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_employee_esi  NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_professional_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_income_tax_tds   NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_net_pay       NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Accounting linkage
    transaction_id    BIGINT REFERENCES transactions(transaction_id),

    status            payroll_status NOT NULL DEFAULT 'DRAFT',
    status_history    JSONB NOT NULL DEFAULT '[]'::jsonb,

    approved_by       VARCHAR(100),
    approved_at       TIMESTAMPTZ,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, pay_period_id)
);

-------------------------------------------------------------------------------
-- 8. PAYROLL RUN DETAILS — Per-employee breakdown for each run
-------------------------------------------------------------------------------

CREATE TABLE payroll_run_details (
    detail_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payroll_run_id    BIGINT       NOT NULL REFERENCES payroll_runs(payroll_run_id),
    employee_id       BIGINT       NOT NULL REFERENCES employees(employee_id),
    tenant_id         UUID         NOT NULL,

    -- Attendance
    days_present      NUMERIC(5,1) NOT NULL DEFAULT 0,
    days_absent       NUMERIC(5,1) NOT NULL DEFAULT 0,
    lop_days          NUMERIC(5,1) NOT NULL DEFAULT 0,
    days_payable      NUMERIC(5,1) NOT NULL DEFAULT 0,

    -- Salary components (computed)
    basic_wage        NUMERIC(18,2) NOT NULL DEFAULT 0,    -- actual basic for this month
    hra               NUMERIC(18,2) NOT NULL DEFAULT 0,
    conveyance        NUMERIC(18,2) NOT NULL DEFAULT 0,
    special_allowance NUMERIC(18,2) NOT NULL DEFAULT 0,
    other_earnings    NUMERIC(18,2) NOT NULL DEFAULT 0,
    gross_earnings    NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Statutory deductions (computed)
    employee_pf       NUMERIC(18,2) NOT NULL DEFAULT 0,
    employee_esi      NUMERIC(18,2) NOT NULL DEFAULT 0,
    professional_tax  NUMERIC(18,2) NOT NULL DEFAULT 0,
    income_tax_tds    NUMERIC(18,2) NOT NULL DEFAULT 0,
    other_deductions  NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_deductions  NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Employer contributions
    employer_pf       NUMERIC(18,2) NOT NULL DEFAULT 0,
    employer_esi      NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Net
    net_pay           NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- PF wage (Basic+DA, capped at ₹15,000)
    pf_wage           NUMERIC(18,2) NOT NULL DEFAULT 0,
    -- ESI wage (Gross ≤ ₹21,000, entire gross is ESI-able)
    esi_wage          NUMERIC(18,2) NOT NULL DEFAULT 0,

    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (payroll_run_id, employee_id)
);

CREATE INDEX idx_payroll_details_employee ON payroll_run_details(employee_id, payroll_run_id);

-------------------------------------------------------------------------------
-- 9. FUNCTION: Compute PF (12% of Basic+DA, capped at ₹15,000)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_pf(
    p_basic_wage  NUMERIC,          -- actual Basic + DA amount for this employee
    p_is_eligible BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
    pf_wage        NUMERIC(18,2),   -- wage considered for PF (capped or actual)
    employee_pf    NUMERIC(18,2),   -- 12% employee share
    employer_pf    NUMERIC(18,2),   -- 3.67% employer PF contribution
    employer_eps   NUMERIC(18,2),   -- 8.33% EPS contribution
    total_pf       NUMERIC(18,2)    -- total remittance
) AS $$
DECLARE
    v_cap          NUMERIC(18,2) := 15000;
    v_emp_rate     NUMERIC(5,3)  := 12.000;
    v_empr_pf_rate NUMERIC(5,3)  := 3.670;
    v_empr_eps_rate NUMERIC(5,3) := 8.330;
    v_base         NUMERIC(18,2);
BEGIN
    IF NOT p_is_eligible THEN
        RETURN QUERY SELECT 0, 0, 0, 0, 0;
        RETURN;
    END IF;

    -- PF wage = actual Basic+DA, but capped at ₹15,000 per month
    v_base := LEAST(p_basic_wage, v_cap);

    RETURN QUERY SELECT
        v_base,
        ROUND(v_base * v_emp_rate      / 100, 2),
        ROUND(v_base * v_empr_pf_rate  / 100, 2),
        ROUND(v_base * v_empr_eps_rate / 100, 2),
        ROUND(v_base * (v_emp_rate + v_empr_pf_rate + v_empr_eps_rate) / 100, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-------------------------------------------------------------------------------
-- 10. FUNCTION: Compute ESI (0.75% employee, 3.25% employer, ≤ ₹21,000)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_esi(
    p_gross_wage  NUMERIC,          -- Gross salary for the month
    p_is_eligible BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
    esi_wage       NUMERIC(18,2),
    employee_esi   NUMERIC(18,2),   -- 0.75%
    employer_esi   NUMERIC(18,2),   -- 3.25%
    total_esi      NUMERIC(18,2)
) AS $$
DECLARE
    v_ceiling       NUMERIC(18,2) := 21000;
    v_emp_rate      NUMERIC(5,3)  := 0.750;
    v_empr_rate     NUMERIC(5,3)  := 3.250;
BEGIN
    IF NOT p_is_eligible OR p_gross_wage > v_ceiling THEN
        RETURN QUERY SELECT 0, 0, 0, 0;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        p_gross_wage,
        ROUND(p_gross_wage * v_emp_rate  / 100, 2),
        ROUND(p_gross_wage * v_empr_rate / 100, 2),
        ROUND(p_gross_wage * (v_emp_rate + v_empr_rate) / 100, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-------------------------------------------------------------------------------
-- 11. FUNCTION: Compute Professional Tax (State-specific slabs)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_professional_tax(
    p_monthly_gross NUMERIC,        -- gross monthly wage
    p_state_code    VARCHAR(2)      -- state from state_master
)
RETURNS TABLE (
    pt_amount   NUMERIC(18,2),
    slab_used   VARCHAR(50)
) AS $$
DECLARE
    v_pt NUMERIC(18,2);
    v_slab VARCHAR(50);
BEGIN
    SELECT sr.fixed_amount, sr.sub_component
    INTO v_pt, v_slab
    FROM statutory_rates sr
    WHERE sr.component = 'PT'
      AND sr.state_code = p_state_code
      AND sr.is_active = TRUE
      AND p_monthly_gross >= sr.slab_from
      AND p_monthly_gross <= sr.slab_to
      AND sr.effective_from <= CURRENT_DATE
      AND (sr.effective_to IS NULL OR sr.effective_to >= CURRENT_DATE)
    ORDER BY sr.slab_from ASC
    LIMIT 1;

    RETURN QUERY SELECT COALESCE(v_pt, 0), COALESCE(v_slab, 'NO_SLAB');
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 12. FUNCTION: Compute Income Tax TDS (Section 192 — Salary)
--    Simplified: projected annual income → slab rate → monthly deduction.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_income_tax_tds(
    p_monthly_taxable_income NUMERIC,     -- Gross - exemptions (HRA, LTA, etc.)
    p_projected_annual       NUMERIC,     -- (monthly × 12) minus declared investments
    p_tax_regime             VARCHAR(10) DEFAULT 'NEW'
)
RETURNS TABLE (
    monthly_tds       NUMERIC(18,2),
    annual_tax        NUMERIC(18,2),
    cess_amount       NUMERIC(18,2),
    slab_description  TEXT
) AS $$
DECLARE
    v_remaining       NUMERIC(18,2);
    v_tax             NUMERIC(18,2) := 0;
    v_slab_desc       TEXT := '';
    v_slab            RECORD;
    v_cess            NUMERIC(18,2);
    v_rebate          NUMERIC(18,2) := 0;
BEGIN
    v_remaining := COALESCE(p_projected_annual, p_monthly_taxable_income * 12);

    -- Rebate u/s 87A: if total income ≤ ₹7,00,000 (New Regime), tax up to ₹25,000 rebated
    IF p_tax_regime = 'NEW' AND v_remaining <= 700000 THEN
        v_rebate := 25000;
    END IF;

    -- Apply slab rates
    FOR v_slab IN
        SELECT sr.rate_percent, sr.slab_from, sr.slab_to, sr.sub_component
        FROM statutory_rates sr
        WHERE sr.component = 'INCOME_TAX'
          AND sr.is_active = TRUE
          AND sr.effective_from <= CURRENT_DATE
          AND (sr.effective_to IS NULL OR sr.effective_to >= CURRENT_DATE)
        ORDER BY sr.slab_from ASC
    LOOP
        IF v_remaining <= 0 THEN EXIT; END IF;

        DECLARE
            slab_width NUMERIC(18,2) := v_slab.slab_to - v_slab.slab_from + 1;
            taxable_in_slab NUMERIC(18,2);
        BEGIN
            taxable_in_slab := LEAST(v_remaining, slab_width);
            v_tax := v_tax + ROUND(taxable_in_slab * v_slab.rate_percent / 100, 2);
            v_slab_desc := v_slab_desc || v_slab.sub_component || ':' || taxable_in_slab || '@' || v_slab.rate_percent || '%; ';
            v_remaining := v_remaining - taxable_in_slab;
        END;
    END LOOP;

    -- Apply rebate
    v_tax := GREATEST(v_tax - v_rebate, 0);

    -- Health & Education Cess @ 4%
    v_cess := ROUND(v_tax * 4 / 100, 2);
    v_tax := v_tax + v_cess;

    -- Monthly TDS
    RETURN QUERY SELECT
        ROUND(v_tax / 12, 2),
        ROUND(v_tax, 2),
        ROUND(v_cess, 2),
        TRIM(TRAILING '; ' FROM v_slab_desc);
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 13. FUNCTION: Adjust salary for LOP (Loss of Pay)
--    Adjusted salary = (Gross Salary / Working Days) × Days Payable
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION adjust_for_lop(
    p_gross_amount   NUMERIC,
    p_working_days   INT,
    p_lop_days       NUMERIC(5,1)
)
RETURNS NUMERIC(18,2) AS $$
BEGIN
    IF p_working_days <= 0 OR p_lop_days <= 0 THEN
        RETURN p_gross_amount;
    END IF;
    RETURN ROUND(p_gross_amount * (p_working_days - p_lop_days) / p_working_days, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-------------------------------------------------------------------------------
-- 14. TRIGGER: Auto-generate Journal Entry on Payroll APPROVAL
--    When status transitions to APPROVED, creates a double-entry journal.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_payroll_generate_journal()
RETURNS TRIGGER AS $$
DECLARE
    v_txn_id           BIGINT;
    v_gross            NUMERIC(18,2);
    v_empr_pf          NUMERIC(18,2);
    v_empr_esi         NUMERIC(18,2);
    v_emp_pf           NUMERIC(18,2);
    v_emp_esi          NUMERIC(18,2);
    v_pt               NUMERIC(18,2);
    v_tds              NUMERIC(18,2);
    v_net_pay          NUMERIC(18,2);
    v_salary_exp_ac    BIGINT;
    v_empr_pf_exp_ac   BIGINT;
    v_empr_esi_exp_ac  BIGINT;
    v_salary_pay_ac    BIGINT;
    v_epf_pay_ac       BIGINT;
    v_esi_pay_ac       BIGINT;
    v_pt_pay_ac        BIGINT;
    v_tds_pay_ac       BIGINT;
BEGIN
    -- Only fire when transitioning TO 'APPROVED'
    IF NEW.status <> 'APPROVED' OR (OLD.status IS NOT NULL AND OLD.status = 'APPROVED') THEN
        RETURN NEW;
    END IF;

    -- Resolve ledger accounts (configurable per tenant — stored in metadata or a settings table)
    -- Here we use a lookup convention: account_code pattern
    SELECT account_id INTO v_salary_exp_ac
    FROM accounts WHERE account_code = '4001' AND is_active = TRUE LIMIT 1;     -- Salaries Expense
    SELECT account_id INTO v_empr_pf_exp_ac
    FROM accounts WHERE account_code = '4002' AND is_active = TRUE LIMIT 1;     -- Employer PF Contribution
    SELECT account_id INTO v_empr_esi_exp_ac
    FROM accounts WHERE account_code = '4003' AND is_active = TRUE LIMIT 1;     -- Employer ESI Contribution
    SELECT account_id INTO v_salary_pay_ac
    FROM accounts WHERE account_code = '2001' AND is_active = TRUE LIMIT 1;     -- Salary Payable
    SELECT account_id INTO v_epf_pay_ac
    FROM accounts WHERE account_code = '2002' AND is_active = TRUE LIMIT 1;     -- EPF Payable
    SELECT account_id INTO v_esi_pay_ac
    FROM accounts WHERE account_code = '2003' AND is_active = TRUE LIMIT 1;     -- ESI Payable
    SELECT account_id INTO v_pt_pay_ac
    FROM accounts WHERE account_code = '2004' AND is_active = TRUE LIMIT 1;     -- PT Payable
    SELECT account_id INTO v_tds_pay_ac
    FROM accounts WHERE account_code = '2005' AND is_active = TRUE LIMIT 1;     -- TDS Payable (Salary)

    -- Sum up the details
    SELECT
        COALESCE(SUM(prd.gross_earnings), 0),
        COALESCE(SUM(prd.employer_pf), 0),
        COALESCE(SUM(prd.employer_esi), 0),
        COALESCE(SUM(prd.employee_pf), 0),
        COALESCE(SUM(prd.employee_esi), 0),
        COALESCE(SUM(prd.professional_tax), 0),
        COALESCE(SUM(prd.income_tax_tds), 0),
        COALESCE(SUM(prd.net_pay), 0)
    INTO v_gross, v_empr_pf, v_empr_esi, v_emp_pf, v_emp_esi, v_pt, v_tds, v_net_pay
    FROM payroll_run_details prd
    WHERE prd.payroll_run_id = NEW.payroll_run_id;

    -- Insert transaction header
    INSERT INTO transactions (tenant_id, txn_date, description, metadata)
    VALUES (
        NEW.tenant_id,
        NEW.run_date,
        'Salary auto-journal: ' || NEW.run_description,
        jsonb_build_object('payroll_run_id', NEW.payroll_run_id, 'type', 'PAYROLL_AUTO')
    )
    RETURNING transaction_id INTO v_txn_id;

    -- Link payroll run to transaction
    UPDATE payroll_runs
    SET transaction_id = v_txn_id, status = 'JOURNAL_POSTED'
    WHERE payroll_run_id = NEW.payroll_run_id;

    -- Insert journal entries (must balance: Debit = Credit)
    -- DEBIT SIDE: Expenses
    INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
    VALUES
        -- Dr Salaries Expense (Gross Salary)
        (v_txn_id, v_salary_exp_ac,   v_gross,    0,           'Gross Salary'),
        -- Dr Employer PF Contribution
        (v_txn_id, v_empr_pf_exp_ac,  v_empr_pf,  0,           'Employer PF Contribution'),
        -- Dr Employer ESI Contribution
        (v_txn_id, v_empr_esi_exp_ac, v_empr_esi, 0,           'Employer ESI Contribution'),

    -- CREDIT SIDE: Liabilities
        -- Cr Salary Payable (Net pay to employees)
        (v_txn_id, v_salary_pay_ac,   0,           v_net_pay,  'Net Salary Payable'),
        -- Cr EPF Payable (Employee PF + Employer PF)
        (v_txn_id, v_epf_pay_ac,      0,           v_emp_pf + v_empr_pf, 'EPF Remittance'),
        -- Cr ESI Payable (Employee ESI + Employer ESI)
        (v_txn_id, v_esi_pay_ac,      0,           v_emp_esi + v_empr_esi, 'ESI Remittance'),
        -- Cr Professional Tax Payable
        (v_txn_id, v_pt_pay_ac,       0,           v_pt,       'Professional Tax'),
        -- Cr TDS Payable (Salary)
        (v_txn_id, v_tds_pay_ac,      0,           v_tds,      'TDS on Salary (u/s 192)');

    -- Note: The ctrg_balance_check (deferred) on journal_entries will validate
    -- that total debits = total credits at COMMIT.

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payroll_auto_journal
    AFTER UPDATE OF status ON payroll_runs
    FOR EACH ROW
    EXECUTE FUNCTION trg_payroll_generate_journal();

-------------------------------------------------------------------------------
-- 15. HELPER VIEW: Salary Register (all employees for a period)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW vw_salary_register AS
SELECT
    pr.payroll_run_id,
    pr.run_description,
    pp.period_name,
    pp.period_start,
    pp.period_end,
    e.employee_code,
    e.first_name || ' ' || COALESCE(e.last_name, '') AS employee_name,
    e.pan,
    e.uan,
    e.esi_ip_number,
    prd.days_present,
    prd.lop_days,
    prd.days_payable,
    prd.basic_wage,
    prd.hra,
    prd.conveyance,
    prd.special_allowance,
    prd.gross_earnings,
    prd.employee_pf,
    prd.employee_esi,
    prd.professional_tax,
    prd.income_tax_tds,
    prd.total_deductions,
    prd.employer_pf,
    prd.employer_esi,
    prd.net_pay
FROM payroll_runs pr
JOIN pay_periods pp ON pp.pay_period_id = pr.pay_period_id
JOIN payroll_run_details prd ON prd.payroll_run_id = pr.payroll_run_id
JOIN employees e ON e.employee_id = prd.employee_id
ORDER BY pr.payroll_run_id, e.employee_code;

-------------------------------------------------------------------------------
-- 16. HELPER VIEW: PF ECR (Electronic Challan cum Return) ready data
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW vw_pf_ecr AS
SELECT
    pr.pay_period_id,
    pp.period_name,
    e.uan,
    e.first_name || ' ' || COALESCE(e.last_name, '') AS member_name,
    e.pf_number,
    prd.pf_wage AS eps_wage_limit_15000,
    prd.employee_pf AS ee_share,
    prd.employer_pf AS er_pf_share,
    prd.employer_pf AS er_eps_share,   -- EPS is tracked inside employer_pf in our calc
    prd.employee_pf + prd.employer_pf * 2 AS total_remittance
FROM payroll_run_details prd
JOIN payroll_runs pr ON pr.payroll_run_id = prd.payroll_run_id
JOIN pay_periods pp ON pp.pay_period_id = pr.pay_period_id
JOIN employees e ON e.employee_id = prd.employee_id
WHERE pr.status IN ('APPROVED', 'JOURNAL_POSTED', 'PAID')
  AND e.uan IS NOT NULL
ORDER BY e.uan;

-------------------------------------------------------------------------------
-- 17. HELPER: append status_history
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION append_status_history_payroll(
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
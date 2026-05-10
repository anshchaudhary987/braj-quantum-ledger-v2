-- ============================================================================
-- EDGE CASES & COMPLIANCE SCHEMA — Retail POS, Fixed Assets, Forex, Year-End
-- PostgreSQL 15+ — Integrates with schema.sql + inventory_schema.sql
-- ============================================================================

-------------------------------------------------------------------------------
-- SECTION 1: POINT OF SALE (POS) — Barcode Rapid Entry + Multi-Tender Payments
-------------------------------------------------------------------------------

-- 1a. Tender Types — Cash, UPI, Card, Wallet, Gift Voucher, etc.
CREATE TABLE pos_tender_types (
    tender_type_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT       NOT NULL,
    tender_code     VARCHAR(20)  NOT NULL,          -- 'CASH', 'UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'WALLET', 'GV'
    tender_name     VARCHAR(50)  NOT NULL,          -- 'Cash', 'UPI (GPay/PhonePe)', 'Credit Card'
    gl_account_id   BIGINT       REFERENCES accounts(account_id),
    settlement_days INT          NOT NULL DEFAULT 0, -- Card: 2 days, UPI: 0 days
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_pos_tender UNIQUE (company_id, tender_code)
);

-- Seed default tender types (application-level, not in migration)
-- CASH (gl=Petty Cash or Cash-in-Hand), UPI (gl=UPI Collection A/c),
-- CREDIT_CARD (gl=HDFC POS Machine A/c), DEBIT_CARD (gl=HDFC POS Machine A/c),
-- WALLET (gl=Paytm Wallet), GV (gl=Gift Voucher Liability)

-- 1b. POS Invoice Header — Rapid checkout
CREATE TABLE pos_invoices (
    pos_invoice_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    invoice_no       VARCHAR(50)  NOT NULL,         -- Auto-generated: POS-000001
    invoice_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
    invoice_time     TIME         NOT NULL DEFAULT CURRENT_TIME,

    -- Counter / User context
    counter_id       VARCHAR(20),                   -- Which POS counter/register
    cashier_user_id  BIGINT       NOT NULL,         -- Which user logged into POS

    -- Customer (nullable for anonymous walk-in)
    customer_account_id BIGINT    REFERENCES accounts(account_id),
    customer_name    VARCHAR(200),
    customer_phone   VARCHAR(15),
    customer_gstin   VARCHAR(15),

    -- Totals (stored for reconciliation, computed from line items)
    item_count       INT          NOT NULL DEFAULT 0,
    subtotal         NUMERIC(18,2) NOT NULL DEFAULT 0,
    discount_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
    taxable_amount   NUMERIC(18,2) NOT NULL DEFAULT 0,
    cgst_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    sgst_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    igst_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    cess_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    round_off        NUMERIC(18,2) NOT NULL DEFAULT 0,
    grand_total      NUMERIC(18,2) NOT NULL DEFAULT 0
                         CHECK (grand_total >= 0),

    -- Multi-tender: if total_tendered >= grand_total, invoice is fully paid
    total_tendered   NUMERIC(18,2) NOT NULL DEFAULT 0,
    change_returned  NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Accounting linkage: one pos_invoice → one transaction_id
    transaction_id   BIGINT       REFERENCES transactions(transaction_id),

    status           VARCHAR(20)  NOT NULL DEFAULT 'COMPLETED'
                         CHECK (status IN ('DRAFT', 'COMPLETED', 'VOIDED', 'REFUNDED')),
    narration        TEXT,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_pos_invoice_no UNIQUE (company_id, invoice_no)
);

CREATE INDEX idx_pos_invoice_date    ON pos_invoices(company_id, invoice_date DESC);
CREATE INDEX idx_pos_invoice_customer ON pos_invoices(customer_account_id);
CREATE INDEX idx_pos_invoice_txn     ON pos_invoices(transaction_id);

-- 1c. POS Invoice Line Items — Barcode-driven rapid entry
CREATE TABLE pos_invoice_items (
    pos_invoice_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pos_invoice_id      BIGINT       NOT NULL REFERENCES pos_invoices(pos_invoice_id) ON DELETE CASCADE,

    -- Barcode-based lookup: scan barcode → resolve to stock_item_id
    barcode             VARCHAR(50),                -- Scanned barcode (from item master)
    stock_item_id       BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),

    item_name           VARCHAR(200) NOT NULL,      -- Denormalised for speed
    hsn_code            VARCHAR(10),                -- For GST invoice

    -- UOM context
    uom_id              BIGINT       NOT NULL REFERENCES uom(uom_id),
    uom_quantity        NUMERIC(18,4) NOT NULL,     -- User-entered qty in this UOM
    base_quantity       NUMERIC(18,4) NOT NULL,     -- Converted to base UOM for inventory

    rate                NUMERIC(18,2) NOT NULL,
    discount_percent    NUMERIC(5,2)  NOT NULL DEFAULT 0,
    discount_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
    taxable_value       NUMERIC(18,2) NOT NULL,

    -- Tax
    gst_rate            NUMERIC(5,2)  NOT NULL DEFAULT 0,
    cgst_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
    sgst_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
    igst_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
    cess_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
    line_total          NUMERIC(18,2) NOT NULL
                            CHECK (line_total >= 0),

    serial_no           INT          NOT NULL DEFAULT 1,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_pos_items_invoice ON pos_invoice_items(pos_invoice_id);

-- 1d. POS Multi-Tender Payments — A ₹1000 bill paid via ₹200 Cash + ₹300 UPI + ₹500 Card
CREATE TABLE pos_payments (
    pos_payment_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pos_invoice_id   BIGINT       NOT NULL REFERENCES pos_invoices(pos_invoice_id) ON DELETE CASCADE,
    tender_type_id   BIGINT       NOT NULL REFERENCES pos_tender_types(tender_type_id),

    amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),

    -- Tender-specific details
    reference_no     VARCHAR(100),                  -- Card last 4 digits / UPI txn ID / GV code
    authorization_code VARCHAR(50),                 -- Bank auth code (card payment)
    terminal_id      VARCHAR(50),                   -- POS terminal / EDC machine ID
    card_type        VARCHAR(20),                   -- 'VISA', 'MASTERCARD', 'RUPAY', 'AMEX'

    -- Settlement tracking (for card payments that settle T+2)
    settlement_date  DATE,
    is_settled       BOOLEAN      NOT NULL DEFAULT FALSE,
    settled_at       TIMESTAMPTZ,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_pos_payments_invoice ON pos_payments(pos_invoice_id);
CREATE INDEX idx_pos_payments_settle ON pos_payments(pos_invoice_id, is_settled)
    WHERE is_settled = FALSE;


-------------------------------------------------------------------------------
-- SECTION 2: FIXED ASSET REGISTER + AUTO-DEPRECIATION
-------------------------------------------------------------------------------

-- 2a. Asset Block Master (Income Tax Act — WDV Block concept)
-- Assets are grouped into "Blocks" by depreciation rate.
-- WDV Depreciation = (Opening WDV + Additions - Sale Proceeds) × Rate
CREATE TABLE asset_blocks (
    asset_block_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    block_name       VARCHAR(100) NOT NULL,         -- 'Building (10%)', 'Plant & Machinery (15%)', 'Computers (40%)'
    depreciation_rate NUMERIC(5,2) NOT NULL,        -- e.g. 15.00 for 15% (Income Tax Act rate)
    block_description TEXT,

    -- Companies Act: SLM rate and useful life
    companies_act_rate  NUMERIC(5,2),               -- e.g. 31.67% for 3-year life computers
    useful_life_years   INT,                         -- e.g. 3 for computers, 15 for plant & machinery
    residual_value_pct  NUMERIC(5,2) DEFAULT 5.00,  -- 5% residual as per Companies Act (Schedule II)

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_asset_block UNIQUE (company_id, block_name)
);

-- Seed common blocks:
-- Building (10%), Furniture (10%), Plant & Machinery (15%), Computers (40%),
-- Motor Vehicles (15%), Intangible Assets (25%), Office Equipment (15%)

-- 2b. Fixed Asset Register — Individual assets
CREATE TABLE fixed_assets (
    asset_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    asset_block_id   BIGINT       NOT NULL REFERENCES asset_blocks(asset_block_id),

    asset_code       VARCHAR(50)  NOT NULL,         -- Internal asset number
    asset_name       VARCHAR(200) NOT NULL,
    asset_description TEXT,
    serial_number    VARCHAR(100),

    -- Financial details
    purchase_date    DATE         NOT NULL,
    purchase_value   NUMERIC(18,2) NOT NULL,        -- Cost of acquisition
    gst_credit_claimed BOOLEAN    NOT NULL DEFAULT FALSE,

    -- Depreciation basis (residual for SLM, full value for WDV)
    residual_value   NUMERIC(18,2) NOT NULL DEFAULT 0,
    depreciable_value NUMERIC(18,2)
                         GENERATED ALWAYS AS (purchase_value - residual_value) STORED,

    -- Companies Act: SLM per annum
    slm_rate         NUMERIC(5,2),
    slm_annual_depr  NUMERIC(18,2)
                         GENERATED ALWAYS AS (ROUND((purchase_value - residual_value) * COALESCE(slm_rate, 0) / 100, 2)) STORED,

    -- Accumulated depreciation
    accumulated_depr NUMERIC(18,2) NOT NULL DEFAULT 0,
    wdv_as_on        NUMERIC(18,2)
                         GENERATED ALWAYS AS (purchase_value - accumulated_depr) STORED,

    -- Status
    status           VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'SOLD', 'DISCARDED', 'IMPAIRED')),
    disposal_date    DATE,
    disposal_value   NUMERIC(18,2),

    -- Accounting linkage
    asset_gl_account_id     BIGINT REFERENCES accounts(account_id),  -- Fixed Asset ledger
    accumulated_depr_gl_id  BIGINT REFERENCES accounts(account_id),  -- Accumulated Depreciation
    depreciation_expense_gl_id BIGINT REFERENCES accounts(account_id), -- Depreciation Expense

    location          VARCHAR(200),
    custodian         VARCHAR(100),

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_asset_code UNIQUE (company_id, asset_code)
);

CREATE INDEX idx_assets_block    ON fixed_assets(asset_block_id);
CREATE INDEX idx_assets_status   ON fixed_assets(company_id, status);
CREATE INDEX idx_assets_purchase ON fixed_assets(purchase_date);

-- 2c. Depreciation Run Log — Audit trail of every auto-depreciation posting
CREATE TABLE depreciation_runs (
    depr_run_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    financial_year   INT          NOT NULL,          -- e.g. 2026 for FY 2025-2026
    run_date         DATE         NOT NULL,          -- Always 31st March / year-end date
    act_type         VARCHAR(20)  NOT NULL           -- 'INCOME_TAX' or 'COMPANIES_ACT'
                         CHECK (act_type IN ('INCOME_TAX', 'COMPANIES_ACT')),
    asset_count      INT          NOT NULL DEFAULT 0,
    total_depreciation NUMERIC(18,2) NOT NULL DEFAULT 0,
    transaction_id   BIGINT       REFERENCES transactions(transaction_id),
    status           VARCHAR(20)  NOT NULL DEFAULT 'COMPLETED'
                         CHECK (status IN ('DRAFT', 'COMPLETED', 'REVERSED')),
    posted_by        BIGINT       NOT NULL,          -- user_id (SYSTEM: 0)
    notes            TEXT,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_depr_run_company ON depreciation_runs(company_id, financial_year);

-- 2d. Depreciation Run Detail — Per-asset breakdown of each run
CREATE TABLE depreciation_run_items (
    depr_run_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    depr_run_id      BIGINT       NOT NULL REFERENCES depreciation_runs(depr_run_id),
    asset_id         BIGINT       NOT NULL REFERENCES fixed_assets(asset_id),

    opening_wdv      NUMERIC(18,2) NOT NULL,         -- Before this year's depreciation
    depreciation_for_year NUMERIC(18,2) NOT NULL,
    closing_wdv      NUMERIC(18,2) NOT NULL,         -- After this year's depreciation

    -- For the journal entry
    journal_entry_id BIGINT       REFERENCES journal_entries(entry_id),

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_depr_run_items_asset ON depreciation_run_items(asset_id, depr_run_id);


-------------------------------------------------------------------------------
-- SECTION 3: FOREX — Unadjusted Gain/Loss Engine (AS-11 Compliance)
-------------------------------------------------------------------------------

-- 3a. Forex Transaction Registry — Every FC invoice tracked
CREATE TABLE forex_transactions (
    fx_txn_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    transaction_id   BIGINT       NOT NULL REFERENCES transactions(transaction_id),

    -- What kind of exposure
    exposure_type    VARCHAR(20)  NOT NULL
                         CHECK (exposure_type IN ('RECEIVABLE', 'PAYABLE', 'LOAN_GIVEN', 'LOAN_TAKEN')),

    -- Foreign currency details
    currency_code    VARCHAR(3)   NOT NULL,          -- 'USD', 'EUR', 'GBP', 'AED'
    fc_amount        NUMERIC(18,2) NOT NULL,         -- Amount in foreign currency

    -- Exchange rate at transaction date (historic)
    transaction_rate NUMERIC(12,6) NOT NULL,         -- e.g. 83.450000 INR per USD
    inr_equivalent   NUMERIC(18,2) NOT NULL,         -- fc_amount × transaction_rate

    -- Counterparty
    counterparty_account_id BIGINT REFERENCES accounts(account_id),
    counterparty_name VARCHAR(200),

    -- Dates
    transaction_date DATE         NOT NULL,
    due_date         DATE,                            -- Expected settlement date
    settlement_date  DATE,                            -- Actual settlement (NULL if pending)

    -- For settled transactions: actual rate at settlement
    settlement_rate  NUMERIC(12,6),                   -- Rate on settlement date
    realized_gain_loss NUMERIC(18,2),                  -- Difference from transaction_rate

    -- Month-end revaluation tracking
    last_reval_date  DATE,                            -- Last month-end when revalued
    last_reval_rate  NUMERIC(12,6),                   -- Rate used in last revaluation
    unrealized_gain_loss NUMERIC(18,2) DEFAULT 0,     -- Accumulated unrealized GL at last reval

    -- Status
    status           VARCHAR(20)  NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'WRITTEN_OFF')),
    outstanding_fc   NUMERIC(18,2) NOT NULL,          -- Remaining FC amount to settle

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_fx_positive CHECK (fc_amount > 0 AND inr_equivalent > 0)
);

CREATE INDEX idx_fx_company_currency ON forex_transactions(company_id, currency_code);
CREATE INDEX idx_fx_status             ON forex_transactions(status)
    WHERE status IN ('OPEN', 'PARTIALLY_SETTLED');
CREATE INDEX idx_fx_date               ON forex_transactions(last_reval_date);

-- 3b. Exchange Rate Master — Daily rates for revaluation
CREATE TABLE exchange_rates (
    rate_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    currency_code    VARCHAR(3)   NOT NULL,
    rate_date        DATE         NOT NULL,
    rate_to_inr      NUMERIC(12,6) NOT NULL,         -- e.g. 83.450000
    source           VARCHAR(50)  NOT NULL DEFAULT 'RBI_REFERENCE', -- 'RBI_REFERENCE', 'FBIL', 'XE'
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_fx_rate UNIQUE (currency_code, rate_date)
);

CREATE INDEX idx_fx_rates_date ON exchange_rates(rate_date DESC, currency_code);

-- 3c. Forex Revaluation Log — Audit trail of every month-end reval
CREATE TABLE forex_revaluation_runs (
    reval_run_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    reval_date       DATE         NOT NULL,          -- Month-end date
    transaction_id   BIGINT       REFERENCES transactions(transaction_id), -- The JE posting
    total_gain       NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_loss       NUMERIC(18,2) NOT NULL DEFAULT 0,
    net_gl           NUMERIC(18,2) NOT NULL DEFAULT 0, -- gain - loss
    fx_txn_count     INT          NOT NULL DEFAULT 0,
    status           VARCHAR(20)  NOT NULL DEFAULT 'COMPLETED',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-------------------------------------------------------------------------------
-- SECTION 4: YEAR-END CLOSING — Auto-close Revenue/Expense → Retained Earnings
-------------------------------------------------------------------------------

-- 4a. Year-End Closing Log — Audit trail
CREATE TABLE year_end_closings (
    closing_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT       NOT NULL,
    financial_year   INT          NOT NULL,
    closing_date     DATE         NOT NULL,          -- 31st March
    executed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    transaction_id   BIGINT       REFERENCES transactions(transaction_id),

    -- Summary
    total_revenue    NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_expenses   NUMERIC(18,2) NOT NULL DEFAULT 0,
    net_profit_loss  NUMERIC(18,2) NOT NULL DEFAULT 0,
    retained_earnings_account_id BIGINT NOT NULL REFERENCES accounts(account_id),

    -- Locking
    year_locked      BOOLEAN      NOT NULL DEFAULT FALSE,
    locked_at        TIMESTAMPTZ,

    executed_by      BIGINT       NOT NULL,          -- SYSTEM: 0 for auto, user_id for manual
    notes            TEXT,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_year_end UNIQUE (company_id, financial_year)
);


-------------------------------------------------------------------------------
-- SECTION 5: GRANULAR VOUCHER-LEVEL ACCESS CONTROL
-------------------------------------------------------------------------------

-- 5a. Voucher Type Registry — Master list of all voucher types in the system
CREATE TABLE voucher_types (
    voucher_type_id  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    voucher_code     VARCHAR(30)  NOT NULL UNIQUE,   -- 'SALES_VOUCHER', 'PURCHASE_VOUCHER', etc.
    voucher_name     VARCHAR(100) NOT NULL,
    module           VARCHAR(30)  NOT NULL,           -- 'ACCOUNTS', 'INVENTORY', 'GST', 'PAYROLL'
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Seed all known voucher types
INSERT INTO voucher_types (voucher_code, voucher_name, module) VALUES
    ('PAYMENT_VOUCHER',          'Payment Voucher',           'ACCOUNTS'),
    ('RECEIPT_VOUCHER',          'Receipt Voucher',           'ACCOUNTS'),
    ('JOURNAL_VOUCHER',          'Journal Voucher',           'ACCOUNTS'),
    ('CONTRA_VOUCHER',           'Contra Voucher',            'ACCOUNTS'),
    ('SALES_VOUCHER',            'Sales Invoice',             'ACCOUNTS'),
    ('PURCHASE_VOUCHER',         'Purchase Invoice',          'ACCOUNTS'),
    ('SALES_RETURN_VOUCHER',     'Sales Return / Credit Note','ACCOUNTS'),
    ('PURCHASE_RETURN_VOUCHER',  'Purchase Return / Debit Note','ACCOUNTS'),
    ('POS_VOUCHER',              'POS Retail Invoice',        'ACCOUNTS'),
    ('SALARY_VOUCHER',           'Salary / Payroll Voucher',  'PAYROLL'),
    ('DEPRECIATION_VOUCHER',     'Depreciation Voucher',      'ACCOUNTS'),
    ('FOREX_REVAL_VOUCHER',      'Forex Revaluation Voucher', 'ACCOUNTS'),
    ('YEAR_END_CLOSING',         'Year-End Closing Entry',    'ACCOUNTS');

-- 5b. Voucher-Level Permissions — Restricts which voucher types a role can use
CREATE TABLE voucher_type_permissions (
    voucher_type_perm_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id              INT    NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    voucher_type_id      INT    NOT NULL REFERENCES voucher_types(voucher_type_id) ON DELETE CASCADE,
    can_create           BOOLEAN NOT NULL DEFAULT TRUE,
    can_view             BOOLEAN NOT NULL DEFAULT TRUE,
    can_edit             BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete           BOOLEAN NOT NULL DEFAULT FALSE,
    can_approve          BOOLEAN NOT NULL DEFAULT FALSE,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_role_voucher_type UNIQUE (role_id, voucher_type_id)
);

CREATE INDEX idx_vtp_role ON voucher_type_permissions(role_id);

-- Seed: ACCOUNTANT can create these vouchers
INSERT INTO voucher_type_permissions (role_id, voucher_type_id, can_create, can_view, can_edit, can_delete, can_approve)
SELECT
    (SELECT role_id FROM roles WHERE role_name = 'ACCOUNTANT'),
    voucher_type_id,
    TRUE, TRUE, TRUE, FALSE, TRUE
FROM voucher_types
WHERE voucher_code IN (
    'PAYMENT_VOUCHER', 'RECEIPT_VOUCHER', 'JOURNAL_VOUCHER', 'CONTRA_VOUCHER',
    'SALES_VOUCHER', 'PURCHASE_VOUCHER', 'SALES_RETURN_VOUCHER', 'PURCHASE_RETURN_VOUCHER'
);

-- Seed: DATA_ENTRY can create only Sales, Purchase, and POS
INSERT INTO voucher_type_permissions (role_id, voucher_type_id, can_create, can_view, can_edit, can_delete)
SELECT
    (SELECT role_id FROM roles WHERE role_name = 'DATA_ENTRY'),
    voucher_type_id,
    TRUE, TRUE, TRUE, FALSE
FROM voucher_types
WHERE voucher_code IN ('SALES_VOUCHER', 'PURCHASE_VOUCHER', 'POS_VOUCHER');

-- Seed: AUDITOR can VIEW all but cannot create/edit/delete
INSERT INTO voucher_type_permissions (role_id, voucher_type_id, can_create, can_view, can_edit, can_delete)
SELECT
    (SELECT role_id FROM roles WHERE role_name = 'AUDITOR'),
    voucher_type_id,
    FALSE, TRUE, FALSE, FALSE
FROM voucher_types;

-- 5c. Permission Check Function — Voucher-Type Granular
CREATE OR REPLACE FUNCTION user_can_access_voucher_type(
    p_user_id        BIGINT,
    p_company_id     BIGINT,
    p_voucher_code   VARCHAR(30),
    p_action         VARCHAR(20)  -- 'CREATE', 'VIEW', 'EDIT', 'DELETE', 'APPROVE'
)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM user_company_roles ucr
        JOIN voucher_type_permissions vtp ON vtp.role_id = ucr.role_id
        JOIN voucher_types vt             ON vt.voucher_type_id = vtp.voucher_type_id
        WHERE ucr.user_id    = p_user_id
          AND ucr.company_id = p_company_id
          AND vt.voucher_code = p_voucher_code
          AND CASE p_action
              WHEN 'CREATE'  THEN vtp.can_create
              WHEN 'VIEW'    THEN vtp.can_view
              WHEN 'EDIT'    THEN vtp.can_edit
              WHEN 'DELETE'  THEN vtp.can_delete
              WHEN 'APPROVE' THEN vtp.can_approve
              ELSE FALSE
          END
    );
END;
$$ LANGUAGE plpgsql STABLE;


-------------------------------------------------------------------------------
-- SECTION 6: AUTO-DEPRECIATION ENGINE — Stored Procedure
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION post_annual_depreciation(
    p_company_id     BIGINT,
    p_financial_year INT,
    p_act_type       VARCHAR(20),          -- 'INCOME_TAX' or 'COMPANIES_ACT'
    p_posted_by      BIGINT DEFAULT 0       -- 0 = SYSTEM for automated runs
) RETURNS BIGINT   -- Returns depr_run_id
LANGUAGE plpgsql AS $$
DECLARE
    v_as_of_date       DATE;
    v_fy_start         DATE;
    v_fy_end           DATE;
    v_txn_description  TEXT;
    v_transaction_id   BIGINT;
    v_depr_run_id      BIGINT;
    v_asset_rec        RECORD;
    v_opening_wdv      NUMERIC(18,2);
    v_depr_amount      NUMERIC(18,2);
    v_closing_wdv      NUMERIC(18,2);
    v_total_depr       NUMERIC(18,2) := 0;
    v_asset_count      INT := 0;
    v_txn_metadata     JSONB;
    v_je_lines         JSONB[] := ARRAY[]::JSONB[];
BEGIN
    v_fy_end := MAKE_DATE(p_financial_year + 1, 3, 31);
    v_fy_start := MAKE_DATE(p_financial_year, 4, 1);
    v_as_of_date := v_fy_end;

    -- Prevent duplicate runs
    IF EXISTS (
        SELECT 1 FROM depreciation_runs
        WHERE company_id = p_company_id
          AND financial_year = p_financial_year
          AND act_type = p_act_type
          AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Depreciation already posted for FY %, act type %', p_financial_year, p_act_type;
    END IF;

    -- Create the depreciation run header
    INSERT INTO depreciation_runs (company_id, financial_year, run_date, act_type, posted_by, status, notes)
    VALUES (p_company_id, p_financial_year, v_as_of_date, p_act_type, p_posted_by, 'DRAFT',
            'Annual depreciation — ' || p_act_type || ' for FY ' || p_financial_year || '-' || (p_financial_year + 1))
    RETURNING depr_run_id INTO v_depr_run_id;

    -- Iterate over each ACTIVE asset (not sold, not discarded, not impaired)
    FOR v_asset_rec IN
        SELECT fa.*, ab.depreciation_rate AS block_rate,
               ab.companies_act_rate, ab.useful_life_years
        FROM fixed_assets fa
        JOIN asset_blocks ab ON ab.asset_block_id = fa.asset_block_id
        WHERE fa.company_id = p_company_id
          AND fa.status = 'ACTIVE'
          AND fa.purchase_date <= v_fy_end
        ORDER BY fa.asset_id
    LOOP
        -- Opening WDV = purchase_value - accumulated_depr BEFORE this year
        v_opening_wdv := v_asset_rec.purchase_value - v_asset_rec.accumulated_depr;

        -- Calculate this year's depreciation
        IF p_act_type = 'INCOME_TAX' THEN
            -- WDV Method: depreciation = Opening WDV × Block Rate%
            -- If asset purchased during the year and used < 180 days, HALF rate applies
            v_depr_amount := ROUND(v_opening_wdv * v_asset_rec.block_rate / 100, 2);

            -- Half-rate rule: asset put to use for less than 180 days
            IF v_asset_rec.purchase_date > MAKE_DATE(p_financial_year, 10, 1) THEN  -- Purchased after 1st Oct
                v_depr_amount := ROUND(v_depr_amount / 2, 2);
            END IF;

        ELSIF p_act_type = 'COMPANIES_ACT' THEN
            -- SLM (Straight Line Method) or WDV based on useful life
            IF v_asset_rec.slm_rate IS NOT NULL AND v_asset_rec.slm_rate > 0 THEN
                -- SLM: (purchase_value - residual_value) × SLM rate%
                v_depr_amount := ROUND((v_asset_rec.purchase_value - v_asset_rec.residual_value) * v_asset_rec.slm_rate / 100, 2);

                -- Pro-rata if purchased during the year
                IF v_asset_rec.purchase_date > v_fy_start THEN
                    -- Number of days from purchase_date to fy_end
                    v_depr_amount := ROUND(v_depr_amount * ((v_fy_end - v_asset_rec.purchase_date)::NUMERIC / 365), 2);
                END IF;
            ELSE
                -- WDV under Companies Act
                v_depr_amount := ROUND(v_opening_wdv * v_asset_rec.block_rate / 100, 2);
            END IF;
        END IF;

        -- Depreciation cannot exceed remaining WDV
        IF v_depr_amount > v_opening_wdv THEN
            v_depr_amount := v_opening_wdv;
        END IF;

        v_closing_wdv := v_opening_wdv - v_depr_amount;

        -- Record the depreciation line
        INSERT INTO depreciation_run_items
            (depr_run_id, asset_id, opening_wdv, depreciation_for_year, closing_wdv)
        VALUES
            (v_depr_run_id, v_asset_rec.asset_id, v_opening_wdv, v_depr_amount, v_closing_wdv);

        -- Update the asset's accumulated depreciation
        UPDATE fixed_assets
        SET accumulated_depr = accumulated_depr + v_depr_amount,
            updated_at       = now()
        WHERE asset_id = v_asset_rec.asset_id;

        -- Build journal entry lines
        IF v_depr_amount > 0 THEN
            -- Debit: Depreciation Expense
            v_je_lines := array_append(v_je_lines,
                jsonb_build_object(
                    'account_id', v_asset_rec.depreciation_expense_gl_id,
                    'debit_amount', v_depr_amount,
                    'credit_amount', 0,
                    'description', 'Depr: ' || v_asset_rec.asset_name
                ));
            -- Credit: Accumulated Depreciation
            v_je_lines := array_append(v_je_lines,
                jsonb_build_object(
                    'account_id', v_asset_rec.accumulated_depr_gl_id,
                    'debit_amount', 0,
                    'credit_amount', v_depr_amount,
                    'description', 'Accum Depr: ' || v_asset_rec.asset_name
                ));
        END IF;

        v_total_depr := v_total_depr + v_depr_amount;
        v_asset_count := v_asset_count + 1;
    END LOOP;

    -- Post the consolidated journal entry for ALL assets
    IF v_total_depr > 0 AND array_length(v_je_lines, 1) > 0 THEN
        v_txn_description := p_act_type || ' Depreciation for FY ' || p_financial_year || '-' || (p_financial_year + 1);
        v_txn_metadata := jsonb_build_object(
            'voucher_type', 'DEPRECIATION_VOUCHER',
            'depr_run_id', v_depr_run_id,
            'act_type', p_act_type
        );

        INSERT INTO transactions (tenant_id, txn_date, description, metadata)
        VALUES (p_company_id::UUID, v_as_of_date, v_txn_description, v_txn_metadata)
        RETURNING transaction_id INTO v_transaction_id;

        -- Insert all journal lines
        FOR i IN 1..array_length(v_je_lines, 1) LOOP
            INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
            VALUES (
                v_transaction_id,
                (v_je_lines[i]->>'account_id')::BIGINT,
                (v_je_lines[i]->>'debit_amount')::NUMERIC,
                (v_je_lines[i]->>'credit_amount')::NUMERIC,
                v_je_lines[i]->>'description'
            );
        END LOOP;

        -- Update run with transaction link
        UPDATE depreciation_runs
        SET transaction_id = v_transaction_id,
            asset_count = v_asset_count,
            total_depreciation = v_total_depr,
            status = 'COMPLETED'
        WHERE depr_run_id = v_depr_run_id;
    ELSE
        -- No depreciation to post (all assets fully depreciated)
        UPDATE depreciation_runs
        SET status = 'COMPLETED', asset_count = 0, total_depreciation = 0
        WHERE depr_run_id = v_depr_run_id;
    END IF;

    RETURN v_depr_run_id;
END;
$$;


-------------------------------------------------------------------------------
-- SECTION 7: MONTH-END FOREX REVALUATION — Stored Procedure (AS-11)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION post_forex_revaluation(
    p_company_id BIGINT,
    p_reval_date DATE,                          -- Month-end date
    p_posted_by  BIGINT DEFAULT 0
) RETURNS BIGINT   -- Returns reval_run_id
LANGUAGE plpgsql AS $$
DECLARE
    v_fx_rec          RECORD;
    v_rate            NUMERIC(12,6);
    v_new_inr         NUMERIC(18,2);
    v_gl_diff         NUMERIC(18,2);
    v_total_gain      NUMERIC(18,2) := 0;
    v_total_loss      NUMERIC(18,2) := 0;
    v_net_gl          NUMERIC(18,2) := 0;
    v_fx_txn_count    INT := 0;
    v_transaction_id  BIGINT;
    v_reval_run_id    BIGINT;
    v_je_lines        JSONB[] := ARRAY[]::JSONB[];
    v_txn_metadata    JSONB;
    v_gl_account_id   BIGINT;
    v_counterparty_rec RECORD;
BEGIN
    -- Prevent duplicate revaluation for same month
    IF EXISTS (
        SELECT 1 FROM forex_revaluation_runs
        WHERE company_id = p_company_id
          AND reval_date = p_reval_date
          AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Forex revaluation already completed for %', p_reval_date;
    END IF;

    -- Create revaluation run header
    INSERT INTO forex_revaluation_runs (company_id, reval_date, status)
    VALUES (p_company_id, p_reval_date, 'DRAFT')
    RETURNING reval_run_id INTO v_reval_run_id;

    -- Iterate over all OPEN forex transactions
    FOR v_fx_rec IN
        SELECT * FROM forex_transactions
        WHERE company_id = p_company_id
          AND status IN ('OPEN', 'PARTIALLY_SETTLED')
          AND outstanding_fc > 0
    LOOP
        -- Get the month-end exchange rate for this currency
        SELECT rate_to_inr INTO v_rate
        FROM exchange_rates
        WHERE currency_code = v_fx_rec.currency_code
          AND rate_date <= p_reval_date
        ORDER BY rate_date DESC
        LIMIT 1;

        IF v_rate IS NULL THEN
            RAISE WARNING 'No exchange rate found for % on %. Skipping fx_txn_id=%',
                v_fx_rec.currency_code, p_reval_date, v_fx_rec.fx_txn_id;
            CONTINUE;
        END IF;

        -- Calculate new INR equivalent: outstanding_fc × new rate
        v_new_inr := ROUND(v_fx_rec.outstanding_fc * v_rate, 2);

        -- Compare with the inr_equivalent that was booked at transaction_rate
        -- (proportionate to outstanding amount)
        -- Old INR for outstanding portion = (outstanding_fc / fc_amount) × original inr_equivalent
        -- Simplified: the delta between revalued and booked
        v_gl_diff := v_new_inr - ROUND((v_fx_rec.outstanding_fc / v_fx_rec.fc_amount) * v_fx_rec.inr_equivalent, 2);

        IF v_gl_diff = 0 THEN CONTINUE; END IF;

        -- Determine if gain or loss
        -- Receivable (Asset): Rate up → INR value up → Gain (Credit), Loss (Debit)
        -- Payable (Liability): Rate up → INR liability up → Loss (Debit), Gain (Credit)
        IF v_fx_rec.exposure_type IN ('RECEIVABLE', 'LOAN_GIVEN') THEN
            -- For assets: increase in INR value = gain (credit Forex Gain a/c)
            IF v_gl_diff > 0 THEN
                v_total_gain := v_total_gain + v_gl_diff;
            ELSE
                v_total_loss := v_total_loss + ABS(v_gl_diff);
            END IF;
        ELSIF v_fx_rec.exposure_type IN ('PAYABLE', 'LOAN_TAKEN') THEN
            -- For liabilities: increase in INR value = loss (debit Forex Loss a/c)
            v_gl_diff := -v_gl_diff;   -- Invert for liability perspective
            IF v_gl_diff > 0 THEN
                v_total_gain := v_total_gain + v_gl_diff;
            ELSE
                v_total_loss := v_total_loss + ABS(v_gl_diff);
            END IF;
        END IF;

        -- Update the forex transaction
        UPDATE forex_transactions
        SET last_reval_date    = p_reval_date,
            last_reval_rate    = v_rate,
            unrealized_gain_loss = v_gl_diff,
            updated_at         = now()
        WHERE fx_txn_id = v_fx_rec.fx_txn_id;

        -- Build journal entry: adjust the counterparty receivable/payable + post GL
        -- Find the forex GL account
        SELECT account_id INTO v_gl_account_id
        FROM accounts
        WHERE company_id = p_company_id
          AND is_active = TRUE
          AND (
              (v_gl_diff > 0 AND account_name ILIKE '%forex gain%')
              OR
              (v_gl_diff < 0 AND account_name ILIKE '%forex loss%')
          )
        LIMIT 1;

        IF v_gl_account_id IS NULL THEN
            RAISE WARNING 'No forex gain/loss GL account found. Skipping JE for fx_txn_id=%', v_fx_rec.fx_txn_id;
            CONTINUE;
        END IF;

        -- Adjust the counterparty account (receivable or payable)
        IF v_gl_diff > 0 THEN
            -- Gain: Debit counterparty (increase receivable / decrease payable), Credit Forex Gain
            v_je_lines := array_append(v_je_lines, jsonb_build_object(
                'account_id', v_fx_rec.counterparty_account_id,
                'debit_amount', ABS(v_gl_diff), 'credit_amount', 0,
                'description', 'FX reval: ' || v_fx_rec.currency_code || ' ' || v_fx_rec.outstanding_fc
            ));
            v_je_lines := array_append(v_je_lines, jsonb_build_object(
                'account_id', v_gl_account_id,
                'debit_amount', 0, 'credit_amount', ABS(v_gl_diff),
                'description', 'Unrealized FX Gain — AS-11'
            ));
        ELSE
            -- Loss: Credit counterparty, Debit Forex Loss
            v_je_lines := array_append(v_je_lines, jsonb_build_object(
                'account_id', v_gl_account_id,
                'debit_amount', ABS(v_gl_diff), 'credit_amount', 0,
                'description', 'Unrealized FX Loss — AS-11'
            ));
            v_je_lines := array_append(v_je_lines, jsonb_build_object(
                'account_id', v_fx_rec.counterparty_account_id,
                'debit_amount', 0, 'credit_amount', ABS(v_gl_diff),
                'description', 'FX reval: ' || v_fx_rec.currency_code || ' ' || v_fx_rec.outstanding_fc
            ));
        END IF;

        v_fx_txn_count := v_fx_txn_count + 1;
    END LOOP;

    v_net_gl := v_total_gain - v_total_loss;

    -- Post the consolidated journal entry
    IF array_length(v_je_lines, 1) > 0 THEN
        v_txn_metadata := jsonb_build_object(
            'voucher_type', 'FOREX_REVAL_VOUCHER',
            'reval_run_id', v_reval_run_id,
            'reval_date', p_reval_date
        );

        INSERT INTO transactions (tenant_id, txn_date, description, metadata)
        VALUES (p_company_id::UUID, p_reval_date,
                'Forex Revaluation — Unrealized Gain/Loss for ' || p_reval_date,
                v_txn_metadata)
        RETURNING transaction_id INTO v_transaction_id;

        FOR i IN 1..array_length(v_je_lines, 1) LOOP
            INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
            VALUES (
                v_transaction_id,
                (v_je_lines[i]->>'account_id')::BIGINT,
                (v_je_lines[i]->>'debit_amount')::NUMERIC,
                (v_je_lines[i]->>'credit_amount')::NUMERIC,
                v_je_lines[i]->>'description'
            );
        END LOOP;

        UPDATE forex_revaluation_runs
        SET transaction_id = v_transaction_id,
            total_gain = v_total_gain,
            total_loss = v_total_loss,
            net_gl = v_net_gl,
            fx_txn_count = v_fx_txn_count,
            status = 'COMPLETED'
        WHERE reval_run_id = v_reval_run_id;
    ELSE
        UPDATE forex_revaluation_runs
        SET status = 'COMPLETED', fx_txn_count = 0
        WHERE reval_run_id = v_reval_run_id;
    END IF;

    RETURN v_reval_run_id;
END;
$$;


-------------------------------------------------------------------------------
-- SECTION 8: YEAR-END CLOSING — Auto-close P&L → Retained Earnings
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION post_year_end_closing(
    p_company_id     BIGINT,
    p_financial_year INT,
    p_executed_by    BIGINT DEFAULT 0        -- 0 = SYSTEM
) RETURNS BIGINT   -- Returns closing_id
LANGUAGE plpgsql AS $$
DECLARE
    v_closing_date       DATE;
    v_fy_start           DATE;
    v_fy_end             DATE;
    v_total_revenue      NUMERIC(18,2);
    v_total_expenses     NUMERIC(18,2);
    v_net_profit_loss    NUMERIC(18,2);
    v_transaction_id     BIGINT;
    v_closing_id         BIGINT;
    v_re_gl_account_id   BIGINT;
    v_txn_metadata       JSONB;
    v_pnl_accounts       RECORD;
    v_je_lines           JSONB[] := ARRAY[]::JSONB[];
    v_period_name        VARCHAR(50);
BEGIN
    v_fy_start := MAKE_DATE(p_financial_year, 4, 1);
    v_fy_end   := MAKE_DATE(p_financial_year + 1, 3, 31);
    v_closing_date := v_fy_end;

    -- Prevent duplicate closing
    IF EXISTS (
        SELECT 1 FROM year_end_closings
        WHERE company_id = p_company_id AND financial_year = p_financial_year
    ) THEN
        RAISE EXCEPTION 'Year-end already closed for FY %', p_financial_year;
    END IF;

    -- Find Retained Earnings account
    SELECT account_id INTO v_re_gl_account_id
    FROM accounts
    WHERE is_active = TRUE
      AND account_name ILIKE '%retained earnings%'
      AND account_type = 'Equity'
    LIMIT 1;

    IF v_re_gl_account_id IS NULL THEN
        RAISE EXCEPTION 'Retained Earnings account not found. Create it in the Chart of Accounts first.';
    END IF;

    -----------------------------------------------------------------
    -- STEP 1: Compute total Revenue for the FY
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(
        CASE a.account_type
            WHEN 'Income' THEN COALESCE(SUM(je.credit_amount), 0) - COALESCE(SUM(je.debit_amount), 0)
            ELSE 0
        END
    ), 0) INTO v_total_revenue
    FROM accounts a
    JOIN journal_entries je ON je.account_id = a.account_id
    JOIN transactions t    ON t.transaction_id = je.transaction_id
    WHERE a.account_type = 'Income'
      AND t.txn_date BETWEEN v_fy_start AND v_fy_end
      AND a.is_active = TRUE;

    -----------------------------------------------------------------
    -- STEP 2: Compute total Expenses for the FY
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(
        CASE a.account_type
            WHEN 'Expense' THEN COALESCE(SUM(je.debit_amount), 0) - COALESCE(SUM(je.credit_amount), 0)
            ELSE 0
        END
    ), 0) INTO v_total_expenses
    FROM accounts a
    JOIN journal_entries je ON je.account_id = a.account_id
    JOIN transactions t    ON t.transaction_id = je.transaction_id
    WHERE a.account_type = 'Expense'
      AND t.txn_date BETWEEN v_fy_start AND v_fy_end
      AND a.is_active = TRUE;

    v_net_profit_loss := v_total_revenue - v_total_expenses;

    -----------------------------------------------------------------
    -- STEP 3: Create the closing journal entry
    -- Debit every Revenue account (to zero it out) → Credit P&L Summary
    -- Credit every Expense account (to zero it out) → Debit P&L Summary
    -- Then: Debit/Credit P&L Summary → Credit/Debit Retained Earnings
    -----------------------------------------------------------------

    -- 3a. Close all Revenue accounts (Income → debit to bring to 0)
    FOR v_pnl_accounts IN
        SELECT
            a.account_id,
            a.account_name,
            COALESCE(SUM(je.credit_amount), 0) - COALESCE(SUM(je.debit_amount), 0) AS balance
        FROM accounts a
        JOIN journal_entries je ON je.account_id = a.account_id
        JOIN transactions t    ON t.transaction_id = je.transaction_id
        WHERE a.account_type = 'Income'
          AND a.is_active = TRUE
          AND t.txn_date BETWEEN v_fy_start AND v_fy_end
        GROUP BY a.account_id, a.account_name
        HAVING COALESCE(SUM(je.credit_amount), 0) - COALESCE(SUM(je.debit_amount), 0) <> 0
    LOOP
        -- Revenue has a credit balance. To close: Debit the revenue account.
        v_je_lines := array_append(v_je_lines, jsonb_build_object(
            'account_id', v_pnl_accounts.account_id,
            'debit_amount', v_pnl_accounts.balance,
            'credit_amount', 0,
            'description', 'Year-end close: ' || v_pnl_accounts.account_name
        ));
    END LOOP;

    -- 3b. Close all Expense accounts (Expense → credit to bring to 0)
    FOR v_pnl_accounts IN
        SELECT
            a.account_id,
            a.account_name,
            COALESCE(SUM(je.debit_amount), 0) - COALESCE(SUM(je.credit_amount), 0) AS balance
        FROM accounts a
        JOIN journal_entries je ON je.account_id = a.account_id
        JOIN transactions t    ON t.transaction_id = je.transaction_id
        WHERE a.account_type = 'Expense'
          AND a.is_active = TRUE
          AND t.txn_date BETWEEN v_fy_start AND v_fy_end
        GROUP BY a.account_id, a.account_name
        HAVING COALESCE(SUM(je.debit_amount), 0) - COALESCE(SUM(je.credit_amount), 0) <> 0
    LOOP
        -- Expense has a debit balance. To close: Credit the expense account.
        v_je_lines := array_append(v_je_lines, jsonb_build_object(
            'account_id', v_pnl_accounts.account_id,
            'debit_amount', 0,
            'credit_amount', v_pnl_accounts.balance,
            'description', 'Year-end close: ' || v_pnl_accounts.account_name
        ));
    END LOOP;

    -- 3c. The balancing entry goes to Retained Earnings
    IF v_net_profit_loss > 0 THEN
        -- Profit: Net Income (debit from closing rev/exp) → Credit Retained Earnings
        v_je_lines := array_append(v_je_lines, jsonb_build_object(
            'account_id', v_re_gl_account_id,
            'debit_amount', 0,
            'credit_amount', v_net_profit_loss,
            'description', 'Net profit transferred to Retained Earnings — FY ' || p_financial_year || '-' || (p_financial_year + 1)
        ));
    ELSIF v_net_profit_loss < 0 THEN
        -- Loss: Debit Retained Earnings → Credit from closing rev/exp
        v_je_lines := array_append(v_je_lines, jsonb_build_object(
            'account_id', v_re_gl_account_id,
            'debit_amount', ABS(v_net_profit_loss),
            'credit_amount', 0,
            'description', 'Net loss transferred to Retained Earnings — FY ' || p_financial_year || '-' || (p_financial_year + 1)
        ));
    END IF;

    -----------------------------------------------------------------
    -- STEP 4: Post the consolidated closing journal entry
    -----------------------------------------------------------------
    IF array_length(v_je_lines, 1) > 0 THEN
        v_txn_metadata := jsonb_build_object(
            'voucher_type', 'YEAR_END_CLOSING',
            'financial_year', p_financial_year
        );

        INSERT INTO transactions (tenant_id, txn_date, description, metadata)
        VALUES (p_company_id::UUID, v_closing_date,
                'Year-End Closing — FY ' || p_financial_year || '-' || (p_financial_year + 1),
                v_txn_metadata)
        RETURNING transaction_id INTO v_transaction_id;

        FOR i IN 1..array_length(v_je_lines, 1) LOOP
            INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
            VALUES (
                v_transaction_id,
                (v_je_lines[i]->>'account_id')::BIGINT,
                (v_je_lines[i]->>'debit_amount')::NUMERIC,
                (v_je_lines[i]->>'credit_amount')::NUMERIC,
                v_je_lines[i]->>'description'
            );
        END LOOP;
    END IF;

    -----------------------------------------------------------------
    -- STEP 5: Lock the financial year period
    -----------------------------------------------------------------
    v_period_name := 'FY ' || p_financial_year || '-' || (p_financial_year + 1);

    INSERT INTO fiscal_periods (company_id, period_name, start_date, end_date, is_locked, is_year_closing, locked_by, locked_at, lock_reason)
    VALUES (p_company_id, v_period_name, v_fy_start, v_fy_end, TRUE, TRUE, p_executed_by, now(),
            'Auto year-end closing on ' || v_closing_date::TEXT)
    ON CONFLICT (company_id, period_name) DO UPDATE
    SET is_locked = TRUE, is_year_closing = TRUE, locked_by = p_executed_by, locked_at = now();

    -----------------------------------------------------------------
    -- STEP 6: Record the closing
    -----------------------------------------------------------------
    INSERT INTO year_end_closings
        (company_id, financial_year, closing_date, executed_at, transaction_id,
         total_revenue, total_expenses, net_profit_loss, retained_earnings_account_id,
         year_locked, locked_at, executed_by, notes)
    VALUES
        (p_company_id, p_financial_year, v_closing_date, now(), v_transaction_id,
         v_total_revenue, v_total_expenses, v_net_profit_loss, v_re_gl_account_id,
         TRUE, now(), p_executed_by,
         'Auto year-end closing. P&L reset for new FY ' || (p_financial_year + 1) || '-' || (p_financial_year + 2))
    RETURNING closing_id INTO v_closing_id;

    RETURN v_closing_id;
END;
$$;
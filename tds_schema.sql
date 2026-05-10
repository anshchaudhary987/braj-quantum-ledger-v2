-- ============================================================================
-- TDS / TCS ENGINE — Automated Tax Deduction & Collection
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. TDS SECTIONS — IT Act section master
-------------------------------------------------------------------------------
CREATE TABLE tds_sections (
    section_id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    section_code              VARCHAR(10)  NOT NULL UNIQUE,   -- '194C', '194J', '194Q', etc.
    section_name              VARCHAR(200) NOT NULL,
    description               TEXT,
    applicable_on             VARCHAR(20)  NOT NULL
                              CHECK (applicable_on IN ('PURCHASE', 'PAYMENT', 'BOTH')),

    -- Thresholds (both must be crossed for TDS to trigger)
    single_bill_threshold     NUMERIC(18,2),                 -- e.g., ₹30,000 per invoice for 194C
    aggregate_yearly_threshold NUMERIC(18,2),                -- e.g., ₹1,00,000 cumulative for 194C

    -- Default rate when all conditions are met
    default_tds_rate          NUMERIC(5,2) NOT NULL,

    -- Surcharge + HEC (Health & Education Cess) — applicable only for non-residents / high income
    surcharge_rate            NUMERIC(5,2) DEFAULT 0,
    health_education_cess     NUMERIC(5,2) DEFAULT 4.00,

    effective_from            DATE         NOT NULL DEFAULT CURRENT_DATE,
    effective_to              DATE,                           -- NULL = currently in force
    is_active                 BOOLEAN      NOT NULL DEFAULT TRUE
);

-------------------------------------------------------------------------------
-- 1b. SECTION RATES per deductee type
-------------------------------------------------------------------------------
CREATE TABLE tds_section_rates (
    rate_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    section_id        BIGINT       NOT NULL REFERENCES tds_sections(section_id) ON DELETE CASCADE,

    deductee_type     VARCHAR(20)  NOT NULL
                      CHECK (deductee_type IN (
                          'INDIVIDUAL_HUF', 'COMPANY', 'OTHERS',
                          'NON_RESIDENT', 'NO_PAN'
                      )),
    tds_rate          NUMERIC(5,2) NOT NULL,                 -- override for this deductee type

    UNIQUE (section_id, deductee_type)
);

-------------------------------------------------------------------------------
-- 2. PAN DETAILS — Linked to party ledger accounts
-------------------------------------------------------------------------------
CREATE TABLE tds_pan_details (
    pan_detail_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id        BIGINT       NOT NULL,

    -- Link to the vendor/customer ledger
    account_id        BIGINT       NOT NULL UNIQUE REFERENCES accounts(account_id),

    pan_number        VARCHAR(10),
    pan_status        VARCHAR(20)  NOT NULL DEFAULT 'NOT_AVAILABLE'
                      CHECK (pan_status IN (
                          'VERIFIED',           -- PAN validated via NSDL/TIN
                          'INVALID',            -- format valid but does not exist
                          'NOT_AVAILABLE',      -- vendor doesn't have PAN
                          'APPLIED',            -- PAN applied but not yet issued
                          'EXEMPT'              -- specifically exempt by notification
                      )),
    deductee_type     VARCHAR(20)  NOT NULL DEFAULT 'OTHERS'
                      CHECK (deductee_type IN ('INDIVIDUAL_HUF', 'COMPANY', 'OTHERS', 'NON_RESIDENT')),

    name_on_pan       VARCHAR(200),
    verified_at       TIMESTAMPTZ,
    verified_by       VARCHAR(50),                            -- 'NSDL', 'MANUAL'

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tds_pan_number ON tds_pan_details(pan_number) WHERE pan_number IS NOT NULL;

-------------------------------------------------------------------------------
-- 3. LOWER / NIL DEDUCTION CERTIFICATES — u/s 197
-------------------------------------------------------------------------------
CREATE TABLE tds_lower_deduction_certs (
    cert_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id          BIGINT       NOT NULL,
    account_id          BIGINT       NOT NULL REFERENCES accounts(account_id),
    section_id          BIGINT       NOT NULL REFERENCES tds_sections(section_id),

    certificate_number  VARCHAR(50)  NOT NULL UNIQUE,

    -- Certificate validity period
    valid_from          DATE         NOT NULL,
    valid_to            DATE         NOT NULL,
    CHECK (valid_to >= valid_from),

    -- Reduced rate or nil
    lower_tds_rate      NUMERIC(5,2),                         -- NULL = nil deduction
    is_nil_deduction    BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Issuing authority details
    issuing_ao_name     VARCHAR(200),
    issuing_ao_code     VARCHAR(50),
    issuing_circle      VARCHAR(100),

    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- 4. THRESHOLD TRACKER — Cumulative amounts per vendor per section per FY
-------------------------------------------------------------------------------
CREATE TABLE tds_threshold_tracker (
    tracker_id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id                BIGINT       NOT NULL,
    section_id                BIGINT       NOT NULL REFERENCES tds_sections(section_id),
    vendor_account_id         BIGINT       NOT NULL REFERENCES accounts(account_id),
    financial_year            INT          NOT NULL,           -- e.g. 2025 = FY 2025-26

    cumulative_taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    cumulative_tds_deducted   NUMERIC(18,2) NOT NULL DEFAULT 0,

    last_transaction_id       BIGINT       REFERENCES transactions(transaction_id),
    last_transaction_date     DATE,
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (company_id, section_id, vendor_account_id, financial_year)
);

CREATE INDEX idx_tds_tracker_active ON tds_threshold_tracker(company_id, vendor_account_id, financial_year);

-------------------------------------------------------------------------------
-- 5. TDS ENTRIES — Every deduction recorded atomically
-------------------------------------------------------------------------------
CREATE TABLE tds_entries (
    tds_entry_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id              BIGINT       NOT NULL,

    -- Accounting linkage
    transaction_id          BIGINT       NOT NULL REFERENCES transactions(transaction_id),
    journal_entry_id        BIGINT       NOT NULL REFERENCES journal_entries(entry_id),

    section_id              BIGINT       NOT NULL REFERENCES tds_sections(section_id),
    vendor_account_id       BIGINT       NOT NULL REFERENCES accounts(account_id),

    -- Amounts
    gross_amount            NUMERIC(18,2) NOT NULL,            -- total bill amount
    taxable_amount          NUMERIC(18,2) NOT NULL,            -- amount on which TDS is computed
    tds_rate                NUMERIC(5,2) NOT NULL,
    tds_amount              NUMERIC(18,2) NOT NULL,
    surcharge_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
    cess_amount             NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_tds               NUMERIC(18,2) NOT NULL,            -- tds + surcharge + cess

    -- Deductee info at time of deduction (snapshot for audit)
    deductee_pan            VARCHAR(10),
    deductee_pan_status     VARCHAR(20),
    deductee_type           VARCHAR(20),

    -- Reason for the rate applied
    rate_source             VARCHAR(30)  NOT NULL DEFAULT 'SECTION_DEFAULT'
                            CHECK (rate_source IN (
                                'SECTION_DEFAULT',             -- regular section rate
                                'NO_PAN_20_PCT',               -- penal rate for no PAN
                                'LOWER_DEDUCTION_CERT',        -- u/s 197 certificate
                                'NIL_DEDUCTION'                -- nil rate certificate
                            )),
    lower_deduction_cert_id BIGINT       REFERENCES tds_lower_deduction_certs(cert_id),

    -- Return filing
    return_period           VARCHAR(7),                        -- '2026-05' for monthly, '2026-Q2' for quarterly
    is_reported             BOOLEAN      NOT NULL DEFAULT FALSE,

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tds_entries_vendor_fy ON tds_entries(vendor_account_id, return_period);
CREATE INDEX idx_tds_entries_txn       ON tds_entries(transaction_id);
CREATE INDEX idx_tds_entries_unreported ON tds_entries(company_id, is_reported) WHERE is_reported = FALSE;

-------------------------------------------------------------------------------
-- 6. TCS ENTRIES — Tax Collected at Source (206C(1H))
-------------------------------------------------------------------------------
CREATE TABLE tcs_entries (
    tcs_entry_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id              BIGINT       NOT NULL,

    transaction_id          BIGINT       NOT NULL REFERENCES transactions(transaction_id),

    buyer_account_id        BIGINT       NOT NULL REFERENCES accounts(account_id),

    -- Cumulative tracking for 206C(1H)
    section_code            VARCHAR(10)  NOT NULL DEFAULT '206C(1H)',
    cumulative_receipts_before NUMERIC(18,2) NOT NULL DEFAULT 0,
    -- Total receipts from this buyer in the FY BEFORE this invoice

    amount_exceeding_50l    NUMERIC(18,2),                    -- portion over ₹50L threshold
    tcs_rate                NUMERIC(5,2) NOT NULL DEFAULT 0.10,  -- 0.1% (or 1% if no PAN)
    tcs_amount              NUMERIC(18,2) NOT NULL,

    buyer_pan               VARCHAR(10),
    buyer_pan_status        VARCHAR(20),

    return_period           VARCHAR(7),
    is_reported             BOOLEAN      NOT NULL DEFAULT FALSE,

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- 7. TAX PAYMENTS — Government challan mapping
-------------------------------------------------------------------------------
CREATE TABLE tax_payments (
    payment_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id              BIGINT       NOT NULL,

    payment_type            VARCHAR(10)  NOT NULL
                            CHECK (payment_type IN ('TDS', 'TCS')),

    -- Challan Identification Number (CIN)
    challan_serial_number   VARCHAR(50)  NOT NULL UNIQUE,      -- as printed on challan / generated by NSDL
    bsr_code                VARCHAR(10)  NOT NULL,             -- Bank Branch code (7 digits)
    challan_date            DATE         NOT NULL,
    deposit_date            DATE,                              -- actual value date

    -- Tax period and type
    section_code            VARCHAR(10)  NOT NULL,             -- e.g. '194C', '194J'
    assessment_year         VARCHAR(10)  NOT NULL,             -- e.g. '2026-27'
    financial_year          INT          NOT NULL,

    -- Amount breakdown
    total_tds_amount        NUMERIC(18,2) NOT NULL,
    interest_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,  -- late payment
    late_fee_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,  -- late filing
    total_paid              NUMERIC(18,2) NOT NULL,

    -- Payment metadata
    payment_mode            VARCHAR(20)  NOT NULL DEFAULT 'ONLINE',
    bank_name               VARCHAR(100),
    instrument_number       VARCHAR(50),                       -- RBI reference / UTR

    -- Verification
    is_verified             BOOLEAN      NOT NULL DEFAULT FALSE,
    verified_by             BIGINT,
    verified_at             TIMESTAMPTZ,
    challan_proof_url       VARCHAR(500),

    narration               TEXT,

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- 7b. PAYMENT MAPPING — Links tds_entries to tax_payments (one challan, many deductions)
-------------------------------------------------------------------------------
CREATE TABLE tax_payment_mappings (
    mapping_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payment_id              BIGINT       NOT NULL REFERENCES tax_payments(payment_id) ON DELETE CASCADE,
    tds_entry_id            BIGINT       REFERENCES tds_entries(tds_entry_id),
    tcs_entry_id            BIGINT       REFERENCES tcs_entries(tcs_entry_id),
    allocated_amount        NUMERIC(18,2) NOT NULL,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CHECK (
        (tds_entry_id IS NOT NULL AND tcs_entry_id IS NULL) OR
        (tcs_entry_id IS NOT NULL AND tds_entry_id IS NULL)
    )
);

CREATE INDEX idx_tpm_payment ON tax_payment_mappings(payment_id);

-------------------------------------------------------------------------------
-- 8. FORM 26Q / 24Q DATA VIEW — Instant return preparation
-------------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_form_26q_data AS
SELECT
    te.company_id,
    te.return_period,
    ts.section_code,
    te.deductee_pan         AS pan_of_deductee,
    a.account_name          AS deductee_name,
    te.deductee_type,
    te.taxable_amount       AS amount_paid_credited,
    te.tds_rate,
    te.tds_amount,
    te.surcharge_amount,
    te.cess_amount,
    te.total_tds            AS total_tax_deducted,
    te.created_at::DATE     AS deduction_date,
    tp.challan_serial_number,
    tp.bsr_code,
    tp.challan_date         AS deposit_date,
    CASE WHEN tp.challan_serial_number IS NOT NULL THEN 'BOOKED' ELSE 'UNPAID' END AS payment_status
FROM tds_entries te
JOIN tds_sections ts ON ts.section_id = te.section_id
JOIN accounts a      ON a.account_id = te.vendor_account_id
LEFT JOIN tax_payment_mappings tpm ON tpm.tds_entry_id = te.tds_entry_id
LEFT JOIN tax_payments tp          ON tp.payment_id = tpm.payment_id;
-- Filter: WHERE te.return_period = '<YYYY-MM>' to generate a specific month's return
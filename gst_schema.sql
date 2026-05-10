-- ============================================================================
-- GST ENGINE — Indian Goods & Services Tax — Fully Automated
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. STATE / UNION TERRITORY MASTER
--    Drives CGST+SGST vs CGST+UTGST vs IGST determination.
-------------------------------------------------------------------------------
CREATE TABLE state_master (
    state_code            VARCHAR(2)   PRIMARY KEY,         -- GSTIN prefix (01-38)
    state_name            VARCHAR(100) NOT NULL,
    state_short_name      VARCHAR(50),
    region_type           VARCHAR(20)  NOT NULL DEFAULT 'STATE'
                          CHECK (region_type IN ('STATE', 'UNION_TERRITORY')),
    has_own_legislature   BOOLEAN      NOT NULL DEFAULT TRUE,
    is_active             BOOLEAN      NOT NULL DEFAULT TRUE
);
-- UT without legislature gets UTGST instead of SGST.

-------------------------------------------------------------------------------
-- 2. HSN / SAC MASTER — Tax rates by commodity / service code
-------------------------------------------------------------------------------
CREATE TABLE hsn_sac_master (
    hsn_sac_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code          VARCHAR(20)  NOT NULL UNIQUE,         -- e.g. '8471', '9954'
    description   TEXT         NOT NULL,
    code_type     VARCHAR(10)  NOT NULL                 -- 'HSN' (goods) or 'SAC' (services)
                  CHECK (code_type IN ('HSN', 'SAC')),

    igst_rate     NUMERIC(5,2) NOT NULL DEFAULT 0.00,   -- total rate (e.g. 18.00)
    cess_rate     NUMERIC(5,2) NOT NULL DEFAULT 0.00,   -- compensation cess (on luxury/sin goods)
    cess_name     VARCHAR(100),                         -- e.g. 'Compensation Cess'

    effective_from DATE        NOT NULL DEFAULT CURRENT_DATE,
    effective_to   DATE,                                -- NULL = currently active

    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,

    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Partial index: fast lookups for currently active rates
CREATE INDEX idx_hsn_active ON hsn_sac_master(code_type, code)
    WHERE is_active = TRUE AND effective_to IS NULL;

-------------------------------------------------------------------------------
-- 3. GST REGISTRATIONS — Maps GSTINs to Account Ledgers
-------------------------------------------------------------------------------
CREATE TABLE gst_registrations (
    gst_registration_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Link to the Chart of Accounts (company, vendor, or customer)
    account_id           BIGINT       UNIQUE REFERENCES accounts(account_id),

    gstin                VARCHAR(15)  NOT NULL UNIQUE,
    legal_name           VARCHAR(200) NOT NULL,               -- as per GST certificate
    trade_name           VARCHAR(200),                        -- optional DBA name

    registration_type    VARCHAR(20)  NOT NULL DEFAULT 'REGULAR'
                         CHECK (registration_type IN (
                             'REGULAR', 'COMPOSITION', 'URD',
                             'SEZ', 'SEZ_DEVELOPER',
                             'NRI', 'EMBASSY', 'GOVERNMENT',
                             'CASUAL', 'NON_RESIDENT_TAXABLE',
                             'INPUT_SERVICE_DISTRIBUTOR',
                             'TAX_DEDUCTOR', 'TAX_COLLECTOR'
                         )),

    -- Derivable from GSTIN but stored for fast joins
    state_code           VARCHAR(2)   NOT NULL REFERENCES state_master(state_code),
    pan                  VARCHAR(10),                         -- extracted from GSTIN

    -- Return filing preferences
    filing_frequency     VARCHAR(10)  DEFAULT 'MONTHLY'
                         CHECK (filing_frequency IN ('MONTHLY', 'QUARTERLY', 'ANNUAL')),

    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast lookup by GSTIN (from API requests)
CREATE INDEX idx_gst_reg_gstin ON gst_registrations(gstin);

-------------------------------------------------------------------------------
-- 4. TAX ENTRIES — Atomic tax line for each journal entry
--    Linked to journal_entries for native accounting ↔ tax integration
-------------------------------------------------------------------------------
CREATE TABLE tax_entries (
    tax_entry_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Links back to the accounting transaction
    transaction_id    BIGINT  NOT NULL
                      REFERENCES transactions(transaction_id)
                      ON DELETE CASCADE,
    journal_entry_id  BIGINT  NOT NULL
                      REFERENCES journal_entries(entry_id)
                      ON DELETE CASCADE,

    -- Who is the vendor/customer on the other side of this transaction?
    counterparty_gstin VARCHAR(15)
                      REFERENCES gst_registrations(gstin),

    -- Tax classification
    tax_type          VARCHAR(10) NOT NULL
                      CHECK (tax_type IN ('INPUT', 'OUTPUT')),

    -- GST component: CGST, SGST, UTGST, IGST, CESS
    component         VARCHAR(10) NOT NULL
                      CHECK (component IN ('CGST', 'SGST', 'UTGST', 'IGST', 'CESS')),

    -- HSN/SAC of the goods/services
    hsn_sac_id        BIGINT      REFERENCES hsn_sac_master(hsn_sac_id),
    hsn_sac_code      VARCHAR(20),

    -- Amount details
    taxable_value     NUMERIC(18,2) NOT NULL CHECK (taxable_value >= 0),
    tax_rate          NUMERIC(5,2)  NOT NULL,
    tax_amount        NUMERIC(18,2) NOT NULL,

    -- Place of supply — determines SGST vs IGST
    place_of_supply_state_code VARCHAR(2) NOT NULL REFERENCES state_master(state_code),

    -- RCM — when the recipient pays tax instead of the supplier
    is_rcm            BOOLEAN      NOT NULL DEFAULT FALSE,
    rcm_reason        VARCHAR(200),                        -- e.g. 'URD Purchase', 'Notified Service'

    -- Return filing status (for GSTR-1, GSTR-3B tracking)
    return_period     VARCHAR(7),                          -- e.g. '2026-05'
    is_reported       BOOLEAN      NOT NULL DEFAULT FALSE,

    narration         TEXT,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast aggregations for GSTR-1 (outward supplies) and GSTR-2A (inward supplies)
CREATE INDEX idx_tax_type_period ON tax_entries(tax_type, return_period) WHERE is_reported = FALSE;

-- Trace from journal entry → tax liability
CREATE INDEX idx_tax_journal ON tax_entries(journal_entry_id);

-- Counterparty reporting
CREATE INDEX idx_tax_counterparty ON tax_entries(counterparty_gstin);

-- Cross-check: validate total tax components within a transaction are consistent
-- (IGST should not coexist with CGST+SGST for the same line)

-------------------------------------------------------------------------------
-- 5. GST RATE HISTORY — Track rate changes over time
-------------------------------------------------------------------------------
CREATE TABLE gst_rate_history (
    rate_history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hsn_sac_id      BIGINT       NOT NULL REFERENCES hsn_sac_master(hsn_sac_id),
    old_igst_rate   NUMERIC(5,2) NOT NULL,
    new_igst_rate   NUMERIC(5,2) NOT NULL,
    old_cess_rate   NUMERIC(5,2),
    new_cess_rate   NUMERIC(5,2),
    change_reason   TEXT,
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    changed_by      VARCHAR(100)
);

-------------------------------------------------------------------------------
-- 6. DATABASE FUNCTIONS — Validation & Logic
-------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6a. Validate GSTIN format
--     Pattern: 2 digits + 5 letters(PAN) + 4 digits + 1 letter + 'Z' + 1 alphanumeric
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_gstin(p_gstin VARCHAR)
RETURNS BOOLEAN AS $$
BEGIN
    -- Basic format check
    IF p_gstin IS NULL OR LENGTH(p_gstin) <> 15 THEN
        RETURN FALSE;
    END IF;

    -- Regex: 2 digits, 5 uppercase letters, 4 digits, 1 uppercase letter, Z, 1 alphanumeric
    IF NOT (p_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$') THEN
        RETURN FALSE;
    END IF;

    -- State code must exist in state_master
    IF NOT EXISTS (
        SELECT 1 FROM state_master WHERE state_code = LEFT(p_gstin, 2) AND is_active = TRUE
    ) THEN
        RETURN FALSE;
    END IF;

    -- TODO: Add checksum validation using Luhn-mod-N algorithm
    -- (The 15th char is a checksum; full implementation would verify it.)

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- 6b. Extract state code from GSTIN
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gstin_state_code(p_gstin VARCHAR)
RETURNS VARCHAR(2) AS $$
BEGIN
    IF NOT validate_gstin(p_gstin) THEN
        RAISE EXCEPTION 'Invalid GSTIN: %', p_gstin;
    END IF;
    RETURN LEFT(p_gstin, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- 6c. Determine tax components for a transaction
--     Given company state + place-of-supply state, returns the correct
--     component split (CGST+SGST, CGST+UTGST, or IGST).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION determine_tax_components(
    p_company_state_code    VARCHAR(2),
    p_place_of_supply_code  VARCHAR(2),
    p_igst_rate             NUMERIC(5,2),
    p_cess_rate             NUMERIC(5,2),
    p_taxable_value         NUMERIC(18,2),
    OUT component           VARCHAR(10),
    OUT tax_rate            NUMERIC(5,2),
    OUT tax_amount          NUMERIC(18,2),
    OUT sort_order          INT
)
RETURNS SETOF RECORD AS $$
DECLARE
    v_is_company_ut  BOOLEAN;
    v_is_pos_ut      BOOLEAN;
    v_company_has_leg BOOLEAN;
    v_pos_has_leg    BOOLEAN;
    v_half_rate      NUMERIC(5,2);
BEGIN
    -- Fetch region types for both states
    SELECT region_type = 'UNION_TERRITORY', has_own_legislature
    INTO v_is_company_ut, v_company_has_leg
    FROM state_master WHERE state_code = p_company_state_code;

    SELECT region_type = 'UNION_TERRITORY', has_own_legislature
    INTO v_is_pos_ut, v_pos_has_leg
    FROM state_master WHERE state_code = p_place_of_supply_code;

    v_half_rate := ROUND(p_igst_rate / 2, 2);

    IF p_company_state_code = p_place_of_supply_code THEN
        -- ── INTRASTATE ──────────────────────────────────────
        IF v_is_pos_ut AND NOT v_pos_has_leg THEN
            -- UT without legislature → CGST (UTGST) + UTGST
            component := 'CGST'; tax_rate := v_half_rate; tax_amount := ROUND(p_taxable_value * v_half_rate / 100, 2); sort_order := 1;
            RETURN NEXT;
            component := 'UTGST'; tax_rate := v_half_rate; tax_amount := ROUND(p_taxable_value * v_half_rate / 100, 2); sort_order := 2;
            RETURN NEXT;
        ELSE
            -- State or UT with legislature → CGST + SGST
            component := 'CGST'; tax_rate := v_half_rate; tax_amount := ROUND(p_taxable_value * v_half_rate / 100, 2); sort_order := 1;
            RETURN NEXT;
            component := 'SGST'; tax_rate := v_half_rate; tax_amount := ROUND(p_taxable_value * v_half_rate / 100, 2); sort_order := 2;
            RETURN NEXT;
        END IF;
    ELSE
        -- ── INTERSTATE ──────────────────────────────────────
        component := 'IGST'; tax_rate := p_igst_rate; tax_amount := ROUND(p_taxable_value * p_igst_rate / 100, 2); sort_order := 1;
        RETURN NEXT;
    END IF;

    -- CESS (if applicable, always on top; applied on taxable value)
    IF p_cess_rate > 0 THEN
        component := 'CESS'; tax_rate := p_cess_rate; tax_amount := ROUND(p_taxable_value * p_cess_rate / 100, 2); sort_order := 10;
        RETURN NEXT;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 6d. Validate place of supply against GSTIN
--     The place-of-supply state code should be valid and correspond to a
--     reasonable business scenario (not stricter than logical consistency).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_place_of_supply(
    p_place_of_supply_code VARCHAR(2),
    p_counterparty_gstin   VARCHAR(15) DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    -- Must be a valid state code
    IF NOT EXISTS (
        SELECT 1 FROM state_master WHERE state_code = p_place_of_supply_code AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Invalid place of supply state code: %', p_place_of_supply_code;
    END IF;

    -- If counterparty GSTIN is provided and is a REGULAR dealer,
    -- the place of supply SHOULD match the counterparty's state for
    -- most B2B transactions (can be overridden for services).
    -- This is a WARNING, not an error — raise notice instead of exception.
    IF p_counterparty_gstin IS NOT NULL AND validate_gstin(p_counterparty_gstin) THEN
        IF LEFT(p_counterparty_gstin, 2) <> p_place_of_supply_code THEN
            RAISE WARNING 'Place of supply (%) differs from counterparty GSTIN state (%) — '
                          'ensure this is intentional (e.g. services to a different location).',
                          p_place_of_supply_code, LEFT(p_counterparty_gstin, 2);
        END IF;
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;
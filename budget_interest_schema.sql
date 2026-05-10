-- ============================================================================
-- BUDGETS + INTEREST CALCULATION + SCENARIOS (Provisional Vouchers)
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. BUDGETS — Per-ledger or per-cost-center, period-based
-------------------------------------------------------------------------------
CREATE TABLE budgets (
    budget_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,

    budget_name        VARCHAR(200) NOT NULL,
    financial_year     INT          NOT NULL,                -- e.g. 2025 for FY 2025-26

    -- A budget is either ledger-based OR cost-center-based
    budget_type        VARCHAR(15)  NOT NULL
                       CHECK (budget_type IN ('LEDGER', 'COST_CENTER')),
    ledger_account_id  BIGINT       REFERENCES accounts(account_id),
    cost_center_id     BIGINT       REFERENCES cost_centers(cost_center_id),

    CHECK (
        (budget_type = 'LEDGER'      AND ledger_account_id IS NOT NULL AND cost_center_id IS NULL) OR
        (budget_type = 'COST_CENTER' AND cost_center_id IS NOT NULL    AND ledger_account_id IS NULL)
    ),

    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE budget_periods (
    period_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    budget_id          BIGINT       NOT NULL REFERENCES budgets(budget_id) ON DELETE CASCADE,

    period_label       VARCHAR(50)  NOT NULL,               -- 'Apr 2026', 'Q1', '2025-26'
    period_start       DATE         NOT NULL,
    period_end         DATE         NOT NULL,
    budget_amount      NUMERIC(18,2) NOT NULL DEFAULT 0.00,

    CHECK (period_end >= period_start),
    UNIQUE (budget_id, period_label)
);

CREATE INDEX idx_budget_periods_range ON budget_periods(budget_id, period_start, period_end);

-- ---------------------------------------------------------------------------
-- Budget vs Actual Variance — SQL function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_budget_variance(
    p_budget_id  BIGINT,
    p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    period_label      TEXT,
    period_start      DATE,
    period_end        DATE,
    budget_amount     NUMERIC(18,2),
    actual_amount     NUMERIC(18,2),
    variance          NUMERIC(18,2),
    variance_pct      NUMERIC(5,2),
    is_over_budget    BOOLEAN
) AS $$
DECLARE
    v_budget_type      VARCHAR(15);
    v_ledger_account   BIGINT;
    v_cost_center      BIGINT;
BEGIN
    SELECT b.budget_type, b.ledger_account_id, b.cost_center_id
    INTO v_budget_type, v_ledger_account, v_cost_center
    FROM budgets b WHERE b.budget_id = p_budget_id;

    RETURN QUERY
    SELECT
        bp.period_label::TEXT,
        bp.period_start,
        bp.period_end,
        bp.budget_amount,
        COALESCE(SUM(
            CASE WHEN v_budget_type = 'LEDGER' THEN
                COALESCE(je.debit_amount, 0)  -- expenses tracked as debits
            ELSE
                cca.allocated_amount           -- cost center: allocated amount
            END
        ), 0)::NUMERIC(18,2) AS actual,
        (bp.budget_amount - COALESCE(SUM(
            CASE WHEN v_budget_type = 'LEDGER' THEN
                COALESCE(je.debit_amount, 0)
            ELSE
                cca.allocated_amount
            END
        ), 0))::NUMERIC(18,2) AS variance,
        CASE WHEN bp.budget_amount > 0 THEN
            ROUND(
                (COALESCE(SUM(
                    CASE WHEN v_budget_type = 'LEDGER' THEN
                        COALESCE(je.debit_amount, 0)
                    ELSE
                        cca.allocated_amount
                    END
                ), 0) / bp.budget_amount) * 100, 2
            )::NUMERIC(5,2)
        ELSE 0
        END,
        COALESCE(SUM(
            CASE WHEN v_budget_type = 'LEDGER' THEN
                COALESCE(je.debit_amount, 0)
            ELSE
                cca.allocated_amount
            END
        ), 0) > bp.budget_amount
    FROM budget_periods bp
    LEFT JOIN journal_entries je
        ON v_budget_type = 'LEDGER'
       AND je.account_id = v_ledger_account
       AND EXISTS (
           SELECT 1 FROM transactions t
           WHERE t.transaction_id = je.transaction_id
             AND t.txn_date BETWEEN bp.period_start AND bp.period_end
             AND t.txn_date <= p_as_of_date
       )
    LEFT JOIN cost_center_allocations cca
        ON v_budget_type = 'COST_CENTER'
       AND cca.cost_center_id = v_cost_center
       AND EXISTS (
           SELECT 1 FROM journal_entries je2
           JOIN transactions t ON t.transaction_id = je2.transaction_id
           WHERE je2.entry_id = cca.journal_entry_id
             AND t.txn_date BETWEEN bp.period_start AND bp.period_end
             AND t.txn_date <= p_as_of_date
       )
    WHERE bp.budget_id = p_budget_id
    GROUP BY bp.period_label, bp.period_start, bp.period_end, bp.budget_amount
    ORDER BY bp.period_start;
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 2. INTEREST CONFIGURATION — Rules for calculating interest
-------------------------------------------------------------------------------
CREATE TABLE interest_configs (
    config_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id            BIGINT        NOT NULL,

    config_name           VARCHAR(200)  NOT NULL,
    interest_type         VARCHAR(10)   NOT NULL DEFAULT 'SIMPLE'
                          CHECK (interest_type IN ('SIMPLE', 'COMPOUND')),

    rate_per_annum        NUMERIC(8,4)  NOT NULL,        -- e.g. 18.0000 = 18%
    compounding_frequency VARCHAR(10)   DEFAULT 'YEARLY'
                          CHECK (compounding_frequency IN ('YEARLY', 'QUARTERLY', 'MONTHLY', 'DAILY')),

    -- Day-count convention
    interest_style        VARCHAR(20)   NOT NULL DEFAULT '365_DAY_YEAR'
                          CHECK (interest_style IN (
                              '30_DAY_MONTH',    -- 360-day year
                              '365_DAY_YEAR',    -- actual calendar
                              'ACTUAL_DAYS'      -- 365/366 based on actual year
                          )),
    grace_period_days     INT           NOT NULL DEFAULT 0,

    -- Optional: link to a specific party ledger (NULL = global default)
    ledger_account_id     BIGINT        REFERENCES accounts(account_id),

    -- Rounding
    round_to_paisa        BOOLEAN       NOT NULL DEFAULT TRUE,

    is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- 3. INTEREST PROVISIONS — Calculated interest on overdue bills
--    Provisions are read-only snapshots; posting creates a real voucher.
-------------------------------------------------------------------------------
CREATE TABLE interest_provisions (
    provision_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id            BIGINT        NOT NULL,
    config_id             BIGINT        NOT NULL REFERENCES interest_configs(config_id),

    -- The overdue bill this interest accrues on
    bill_ref_id           BIGINT        NOT NULL REFERENCES bill_references(bill_ref_id),

    -- Snapshot of the calculation
    provision_date        DATE          NOT NULL,         -- when this provision was calculated
    principal_amount      NUMERIC(18,2) NOT NULL,         -- pending_amount at calculation time
    interest_rate         NUMERIC(8,4)  NOT NULL,
    days_overdue          INT           NOT NULL,
    calculated_interest   NUMERIC(18,2) NOT NULL,

    -- Lifecycle
    is_posted             BOOLEAN       NOT NULL DEFAULT FALSE,
    posted_transaction_id BIGINT        REFERENCES transactions(transaction_id),
    posted_at             TIMESTAMPTZ,

    created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_interest_prov_bill
    ON interest_provisions(bill_ref_id, provision_date DESC);

CREATE INDEX idx_interest_prov_unposted
    ON interest_provisions(company_id, is_posted)
    WHERE is_posted = FALSE;

-- ---------------------------------------------------------------------------
-- INTEREST CALCULATION FUNCTION — Pure SQL implementation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calculate_interest(
    p_principal       NUMERIC,      -- outstanding bill amount
    p_rate_per_annum  NUMERIC,      -- e.g. 18.0 = 18%
    p_days_overdue    INT,          -- number of days past (due_date + grace)
    p_interest_type   VARCHAR,      -- 'SIMPLE' or 'COMPOUND'
    p_interest_style  VARCHAR,      -- 30_DAY_MONTH, 365_DAY_YEAR, ACTUAL_DAYS
    p_compound_freq   VARCHAR       -- YEARLY, QUARTERLY, MONTHLY, DAILY
)
RETURNS NUMERIC(18,2) AS $$
DECLARE
    v_days_in_year    INT;
    v_time_years      NUMERIC(12,8);
    v_rate            NUMERIC(8,6);
    v_compound_n      INT;
    v_result          NUMERIC(18,4);
BEGIN
    -- Determine days in year based on interest style
    v_days_in_year := CASE p_interest_style
        WHEN '30_DAY_MONTH' THEN 360
        WHEN '365_DAY_YEAR' THEN 365
        WHEN 'ACTUAL_DAYS'  THEN
            EXTRACT(DOY FROM (DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year' - INTERVAL '1 day'))
        ELSE 365
    END;

    v_time_years := p_days_overdue::NUMERIC / v_days_in_year::NUMERIC;
    v_rate       := p_rate_per_annum / 100.0;  -- convert percentage to decimal

    IF p_interest_type = 'SIMPLE' THEN
        -- SI = P × R × T
        v_result := p_principal * v_rate * v_time_years;

    ELSE -- COMPOUND
        -- CI = P × [(1 + R/n)^(n×T) - 1]
        v_compound_n := CASE p_compound_freq
            WHEN 'YEARLY'    THEN 1
            WHEN 'QUARTERLY' THEN 4
            WHEN 'MONTHLY'   THEN 12
            WHEN 'DAILY'     THEN 365
            ELSE 1
        END;

        v_result := p_principal * (
            POWER((1 + v_rate / v_compound_n), (v_compound_n * v_time_years)) - 1
        );
    END IF;

    RETURN ROUND(v_result, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- PROVISION ALL OVERDUE BILLS — Batch function
--    Calculates and stores interest provisions for ALL overdue bills
--    for a given company / config.  Called nightly or on-demand.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION provision_overdue_interest(
    p_company_id    BIGINT,
    p_config_id     BIGINT,
    p_as_of_date    DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    bill_ref_id         BIGINT,
    bill_number         TEXT,
    pending_amount      NUMERIC(18,2),
    days_overdue        INT,
    calculated_interest NUMERIC(18,2),
    provision_id        BIGINT
) AS $$
DECLARE
    v_config interest_configs%ROWTYPE;
    v_bill   RECORD;
    v_prov_id BIGINT;
    v_existing BIGINT;
BEGIN
    SELECT * INTO v_config
    FROM interest_configs
    WHERE config_id  = p_config_id
      AND company_id = p_company_id
      AND is_active  = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Interest config % not found or inactive.', p_config_id;
    END IF;

    FOR v_bill IN
        SELECT br.bill_ref_id, br.bill_number, br.pending_amount,
               br.due_date, br.ledger_account_id,
               (p_as_of_date - br.due_date - v_config.grace_period_days) AS days_od
        FROM bill_references br
        WHERE br.company_id       = p_company_id
          AND br.reference_type  IN ('NEW_REF', 'ADVANCE')
          AND br.status          IN ('PENDING', 'PARTIALLY_PAID')
          AND br.pending_amount   > 0
          AND (v_config.ledger_account_id IS NULL
               OR br.ledger_account_id = v_config.ledger_account_id)
          AND (p_as_of_date - br.due_date - v_config.grace_period_days) > 0
        ORDER BY br.due_date
    LOOP
        -- Skip if already provisioned today
        SELECT provision_id INTO v_existing
        FROM interest_provisions
        WHERE bill_ref_id    = v_bill.bill_ref_id
          AND provision_date = p_as_of_date
          AND is_posted      = FALSE
        LIMIT 1;

        IF FOUND THEN
            -- Return existing provision instead of recalculating
            RETURN QUERY
            SELECT ip.bill_ref_id, v_bill.bill_number::TEXT,
                   ip.principal_amount, ip.days_overdue,
                   ip.calculated_interest, ip.provision_id
            FROM interest_provisions ip
            WHERE ip.provision_id = v_existing;
            CONTINUE;
        END IF;

        INSERT INTO interest_provisions
            (company_id, config_id, bill_ref_id, provision_date,
             principal_amount, interest_rate, days_overdue,
             calculated_interest)
        VALUES
            (p_company_id, p_config_id, v_bill.bill_ref_id, p_as_of_date,
             v_bill.pending_amount, v_config.rate_per_annum, v_bill.days_od,
             calculate_interest(
                 v_bill.pending_amount,
                 v_config.rate_per_annum,
                 v_bill.days_od,
                 v_config.interest_type,
                 v_config.interest_style,
                 v_config.compounding_frequency
             ))
        RETURNING provision_id INTO v_prov_id;

        RETURN QUERY
        SELECT ip.bill_ref_id, v_bill.bill_number::TEXT,
               ip.principal_amount, ip.days_overdue,
               ip.calculated_interest, ip.provision_id
        FROM interest_provisions ip
        WHERE ip.provision_id = v_prov_id;
    END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-------------------------------------------------------------------------------
-- 4. SCENARIOS — Provisional / Forecast vouchers
--    Stored separately from real transactions so they NEVER affect
--    the Balance Sheet, account_balances, GST returns, or bank recs.
-------------------------------------------------------------------------------
CREATE TABLE scenarios (
    scenario_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,
    scenario_name      VARCHAR(200) NOT NULL,
    description        TEXT,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE scenario_vouchers (
    scenario_voucher_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scenario_id          BIGINT       NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
    company_id           BIGINT       NOT NULL,

    voucher_date         DATE         NOT NULL,
    description          TEXT,
    voucher_type         VARCHAR(50)  NOT NULL,
    metadata             JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- If promoted to a real voucher, store the link
    is_promoted          BOOLEAN      NOT NULL DEFAULT FALSE,
    promoted_transaction_id BIGINT    REFERENCES transactions(transaction_id),

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE scenario_entries (
    scenario_entry_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scenario_voucher_id  BIGINT       NOT NULL REFERENCES scenario_vouchers(scenario_voucher_id) ON DELETE CASCADE,

    account_id           BIGINT       NOT NULL REFERENCES accounts(account_id),
    debit_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
    credit_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
    description          TEXT,

    CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (credit_amount > 0 AND debit_amount = 0)
    )
);

CREATE INDEX idx_scenario_vouchers ON scenario_vouchers(scenario_id, voucher_date);
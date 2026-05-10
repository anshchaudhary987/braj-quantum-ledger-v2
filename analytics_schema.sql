-- ============================================================================
-- ADVANCED ANALYTICS & REPORTING LAYER — Cash Flow, Ratios, Inventory Aging
-- PostgreSQL 15+ — Depends on schema.sql + inventory_schema.sql
-- ============================================================================

-- Extension for uuid generation in cache tables
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- 1. COA CLASSIFICATION EXTENSIONS — Required for auto-segregation
-------------------------------------------------------------------------------

-- Cash flow section: IAS 7 classification at the account level
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cash_flow_section VARCHAR(20)
    CHECK (cash_flow_section IN ('OPERATING', 'INVESTING', 'FINANCING', NULL));

-- Sub-type: distinguishes current/non-current, depreciation, amortisation, etc.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_sub_type VARCHAR(40);
-- Examples: 'CURRENT', 'NON_CURRENT', 'DEPRECIATION', 'AMORTISATION', 'PROVISION'

-- Identifies cash & cash-equivalent accounts (bank, cash-in-hand)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_cash_account BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for fast classification lookups
CREATE INDEX IF NOT EXISTS idx_accounts_cf_section
    ON accounts(cash_flow_section) WHERE cash_flow_section IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_cash
    ON accounts(is_cash_account) WHERE is_cash_account = TRUE;

-- Seed classification for the sample seed accounts (idempotent)
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 1;   -- Assets (parent)
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 2;   -- Current Assets (parent)
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 3;   -- Bank Accounts (parent)
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = TRUE  WHERE account_id = 4;   -- SBI Current A/c
UPDATE accounts SET cash_flow_section = 'FINANCING',account_sub_type = 'NON_CURRENT', is_cash_account = FALSE WHERE account_id = 5; -- Liabilities (parent)
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = 'CURRENT',     is_cash_account = FALSE WHERE account_id = 6; -- Current Liabilities
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = 'CURRENT',     is_cash_account = FALSE WHERE account_id = 7; -- Accounts Payable
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 8;   -- Income
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 9;   -- Sales Revenue
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 10;  -- Expenses
UPDATE accounts SET cash_flow_section = 'OPERATING', account_sub_type = NULL, is_cash_account = FALSE WHERE account_id = 11;  -- Rent Expense


-------------------------------------------------------------------------------
-- 2. UTILITY FUNCTIONS
-------------------------------------------------------------------------------

-- Helper: Indian financial year (April — March)
CREATE OR REPLACE FUNCTION get_financial_year(txn_date DATE)
RETURNS INT AS $$
BEGIN
    IF EXTRACT(MONTH FROM txn_date) >= 4 THEN
        RETURN EXTRACT(YEAR FROM txn_date)::INT;
    ELSE
        RETURN EXTRACT(YEAR FROM txn_date)::INT - 1;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Helper: first day of financial year for a given date
CREATE OR REPLACE FUNCTION get_fy_start_date(as_of_date DATE)
RETURNS DATE AS $$
BEGIN
    IF EXTRACT(MONTH FROM as_of_date) >= 4 THEN
        RETURN MAKE_DATE(EXTRACT(YEAR FROM as_of_date)::INT, 4, 1);
    ELSE
        RETURN MAKE_DATE(EXTRACT(YEAR FROM as_of_date)::INT - 1, 4, 1);
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-------------------------------------------------------------------------------
-- 3. CASH FLOW STATEMENT — Indirect Method (IAS 7)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION generate_cash_flow_statement(
    p_tenant_id UUID,
    p_from_date DATE,
    p_to_date   DATE
) RETURNS TABLE(
    section           VARCHAR(30),
    line_item         VARCHAR(200),
    amount            NUMERIC(18,2),
    sort_order        INT
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_net_income         NUMERIC(18,2);
    v_non_cash_total     NUMERIC(18,2);
    v_wc_cash_impact     NUMERIC(18,2);
    v_operating_total    NUMERIC(18,2);
    v_investing_total    NUMERIC(18,2);
    v_financing_total    NUMERIC(18,2);
    v_cash_proof         NUMERIC(18,2);
BEGIN
    -----------------------------------------------------------------
    -- 0. PERIOD MOVEMENT — net change per account for the period
    -----------------------------------------------------------------
    CREATE TEMP TABLE _cf_period_movement ON COMMIT DROP AS
        SELECT
            a.account_id,
            a.account_name,
            a.account_type,
            a.cash_flow_section,
            a.account_sub_type,
            a.is_cash_account,
            COALESCE(SUM(je.debit_amount),  0) AS total_debit,
            COALESCE(SUM(je.credit_amount), 0) AS total_credit
        FROM accounts a
        JOIN journal_entries je ON je.account_id = a.account_id
        JOIN transactions t   ON t.transaction_id = je.transaction_id
        WHERE t.tenant_id = p_tenant_id
          AND t.txn_date  BETWEEN p_from_date AND p_to_date
        GROUP BY a.account_id, a.account_name, a.account_type,
                 a.cash_flow_section, a.account_sub_type, a.is_cash_account;

    -----------------------------------------------------------------
    -- Net Income = Revenue - Expenses (excluding non-cash)
    -----------------------------------------------------------------
    SELECT
        COALESCE(SUM(net_change) FILTER (WHERE account_type = 'Income'),  0)
      - COALESCE(SUM(net_change) FILTER (WHERE account_type = 'Expense' AND account_sub_type IS DISTINCT FROM 'DEPRECIATION' AND account_sub_type IS DISTINCT FROM 'AMORTISATION'), 0)
    INTO v_net_income
    FROM (
        SELECT
            account_type,
            account_sub_type,
            CASE account_type
                WHEN 'Asset'   THEN total_debit  - total_credit
                WHEN 'Expense' THEN total_debit  - total_credit
                ELSE                total_credit - total_debit
            END AS net_change
        FROM _cf_period_movement
    ) s;

    -----------------------------------------------------------------
    -- Non-cash addbacks (depreciation, amortisation)
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(net_change), 0) INTO v_non_cash_total
    FROM (
        SELECT
            CASE account_type
                WHEN 'Expense' THEN total_debit - total_credit
                ELSE total_credit - total_debit
            END AS net_change
        FROM _cf_period_movement
        WHERE account_sub_type IN ('DEPRECIATION', 'AMORTISATION')
    ) s;

    -----------------------------------------------------------------
    -- Working capital changes (OPERATING, non-cash, non-non-cash items)
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(
        CASE
            WHEN account_type = 'Asset' THEN -(total_debit - total_credit)
            ELSE total_credit - total_debit
        END
    ), 0) INTO v_wc_cash_impact
    FROM _cf_period_movement
    WHERE cash_flow_section = 'OPERATING'
      AND is_cash_account   = FALSE
      AND account_sub_type IS DISTINCT FROM 'DEPRECIATION'
      AND account_sub_type IS DISTINCT FROM 'AMORTISATION'
      AND (total_debit - total_credit) <> 0;

    -----------------------------------------------------------------
    -- Investing activities
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(
        CASE
            WHEN account_type = 'Asset' THEN -(total_debit - total_credit)
            ELSE total_credit - total_debit
        END
    ), 0) INTO v_investing_total
    FROM _cf_period_movement
    WHERE cash_flow_section = 'INVESTING';

    -----------------------------------------------------------------
    -- Financing activities
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(
        CASE
            WHEN account_type = 'Asset' THEN -(total_debit - total_credit)
            ELSE total_credit - total_debit
        END
    ), 0) INTO v_financing_total
    FROM _cf_period_movement
    WHERE cash_flow_section = 'FINANCING';

    -----------------------------------------------------------------
    -- Cash proof: actual net movement in cash accounts
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(total_debit - total_credit), 0) INTO v_cash_proof
    FROM _cf_period_movement
    WHERE is_cash_account = TRUE;

    v_operating_total := v_net_income + v_non_cash_total + v_wc_cash_impact;

    -----------------------------------------------------------------
    -- ASSEMBLE OUTPUT
    -----------------------------------------------------------------
    RETURN QUERY

    -- (1) Net Income
    SELECT 'OPERATING'::VARCHAR(30),
           'Net Income',
           v_net_income,
           1
    UNION ALL

    -- (2) Non-cash adjustments (per-account detail)
    SELECT 'OPERATING'::VARCHAR(30),
           'Add back: ' || account_name,
           CASE account_type
               WHEN 'Expense' THEN total_debit - total_credit
               ELSE total_credit - total_debit
           END,
           2
    FROM _cf_period_movement
    WHERE account_sub_type IN ('DEPRECIATION', 'AMORTISATION')
      AND (total_debit - total_credit) <> 0
    ORDER BY account_name

    UNION ALL

    -- (3) Working capital changes (per-account detail)
    SELECT 'OPERATING'::VARCHAR(30),
           'Change in ' || account_name,
           CASE
               WHEN account_type = 'Asset' THEN -(total_debit - total_credit)
               ELSE total_credit - total_debit
           END,
           3
    FROM _cf_period_movement
    WHERE cash_flow_section = 'OPERATING'
      AND is_cash_account   = FALSE
      AND account_sub_type IS DISTINCT FROM 'DEPRECIATION'
      AND account_sub_type IS DISTINCT FROM 'AMORTISATION'
      AND (total_debit - total_credit) <> 0
    ORDER BY account_name

    UNION ALL

    -- (4) Operating subtotal
    SELECT 'OPERATING'::VARCHAR(30),
           'Net Cash from Operating Activities',
           v_operating_total,
           4

    UNION ALL

    -- (5) Investing detail
    SELECT 'INVESTING'::VARCHAR(30),
           account_name,
           CASE
               WHEN account_type = 'Asset' THEN -(total_debit - total_credit)
               ELSE total_credit - total_debit
           END,
           10
    FROM _cf_period_movement
    WHERE cash_flow_section = 'INVESTING'
      AND (total_debit - total_credit) <> 0
    ORDER BY account_name

    UNION ALL

    -- (6) Investing subtotal
    SELECT 'INVESTING'::VARCHAR(30),
           'Net Cash from Investing Activities',
           v_investing_total,
           11

    UNION ALL

    -- (7) Financing detail
    SELECT 'FINANCING'::VARCHAR(30),
           account_name,
           CASE
               WHEN account_type = 'Asset' THEN -(total_debit - total_credit)
               ELSE total_credit - total_debit
           END,
           20
    FROM _cf_period_movement
    WHERE cash_flow_section = 'FINANCING'
      AND (total_debit - total_credit) <> 0
    ORDER BY account_name

    UNION ALL

    -- (8) Financing subtotal
    SELECT 'FINANCING'::VARCHAR(30),
           'Net Cash from Financing Activities',
           v_financing_total,
           21

    UNION ALL

    -- (9) Net change
    SELECT 'RECONCILIATION'::VARCHAR(30),
           'Net Increase/(Decrease) in Cash',
           v_operating_total + v_investing_total + v_financing_total,
           30

    UNION ALL

    -- (10) Cash proof
    SELECT 'RECONCILIATION'::VARCHAR(30),
           'Per cash accounts (proof)',
           v_cash_proof,
           31

    UNION ALL

    -- (11) Variance (should be 0.00)
    SELECT 'RECONCILIATION'::VARCHAR(30),
           'Variance',
           (v_operating_total + v_investing_total + v_financing_total) - v_cash_proof,
           32

    ORDER BY sort_order, line_item;
END;
$$;


-------------------------------------------------------------------------------
-- 4. AUTOMATED RATIO ANALYSIS
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION calculate_financial_ratios(
    p_tenant_id  UUID,
    p_as_of_date DATE
) RETURNS TABLE(
    ratio_name    VARCHAR(50),
    ratio_value   NUMERIC(12,4),
    numerator     NUMERIC(18,2),
    denominator   NUMERIC(18,2),
    formula       VARCHAR(100),
    health        VARCHAR(20)
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_fy              INT;
    v_current_assets  NUMERIC(18,2) := 0;
    v_non_current_assets NUMERIC(18,2) := 0;
    v_total_assets    NUMERIC(18,2) := 0;
    v_current_liabilities NUMERIC(18,2) := 0;
    v_non_current_liabilities NUMERIC(18,2) := 0;
    v_total_liabilities NUMERIC(18,2) := 0;
    v_total_equity    NUMERIC(18,2) := 0;
    v_inventory       NUMERIC(18,2) := 0;
    v_cash            NUMERIC(18,2) := 0;
    v_total_revenue   NUMERIC(18,2) := 0;
    v_total_expenses  NUMERIC(18,2) := 0;
    v_net_income      NUMERIC(18,2) := 0;
    v_cogs            NUMERIC(18,2) := 0;
BEGIN
    v_fy := get_financial_year(p_as_of_date);

    -----------------------------------------------------------------
    -- Balance Sheet (from account_balances — instant snapshot)
    -----------------------------------------------------------------
    SELECT
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Asset'    AND account_sub_type = 'CURRENT'), 0),
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Asset'    AND account_sub_type = 'NON_CURRENT'), 0),
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Asset'), 0),
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Liability' AND account_sub_type = 'CURRENT'), 0),
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Liability' AND account_sub_type = 'NON_CURRENT'), 0),
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Liability'), 0),
        COALESCE(SUM(balance) FILTER (WHERE account_type = 'Equity'), 0),
        COALESCE(SUM(balance) FILTER (WHERE is_cash_account = TRUE), 0)
    INTO
        v_current_assets, v_non_current_assets, v_total_assets,
        v_current_liabilities, v_non_current_liabilities, v_total_liabilities,
        v_total_equity, v_cash
    FROM (
        SELECT
            a.account_type,
            a.account_sub_type,
            a.is_cash_account,
            CASE a.account_type
                WHEN 'Asset'   THEN COALESCE(ab.closing_balance, 0)
                WHEN 'Expense' THEN COALESCE(ab.closing_balance, 0)
                ELSE                -COALESCE(ab.closing_balance, 0)
            END AS balance
        FROM account_balances ab
        JOIN accounts a ON a.account_id = ab.account_id
        WHERE ab.financial_year = v_fy
          AND a.is_active = TRUE
    ) bs;

    -----------------------------------------------------------------
    -- Inventory (from stock_valuations — always current)
    -----------------------------------------------------------------
    SELECT COALESCE(SUM(total_value), 0) INTO v_inventory FROM stock_valuations;

    -----------------------------------------------------------------
    -- P&L (period: FY start → as_of_date)
    -----------------------------------------------------------------
    SELECT
        COALESCE(SUM(net_change) FILTER (WHERE account_type = 'Income'),  0),
        COALESCE(SUM(net_change) FILTER (WHERE account_type = 'Expense'), 0)
    INTO v_total_revenue, v_total_expenses
    FROM (
        SELECT
            a.account_type,
            COALESCE(SUM(je.credit_amount), 0) - COALESCE(SUM(je.debit_amount), 0) AS net_change
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        JOIN accounts a     ON a.account_id     = je.account_id
        WHERE t.tenant_id  = p_tenant_id
          AND a.account_type IN ('Income', 'Expense')
          AND t.txn_date BETWEEN get_fy_start_date(p_as_of_date) AND p_as_of_date
        GROUP BY a.account_type
    ) pl;

    v_net_income := v_total_revenue - v_total_expenses;

    -- COGS: If you have a dedicated COGS account sub_type, pull from there.
    -- Otherwise, use all direct-cost expense accounts or map via account_sub_type = 'COGS'.
    SELECT COALESCE(SUM(net_change), 0) INTO v_cogs
    FROM (
        SELECT
            COALESCE(SUM(je.credit_amount), 0) - COALESCE(SUM(je.debit_amount), 0) AS net_change
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        JOIN accounts a     ON a.account_id     = je.account_id
        WHERE t.tenant_id  = p_tenant_id
          AND a.account_sub_type = 'COGS'
          AND t.txn_date BETWEEN get_fy_start_date(p_as_of_date) AND p_as_of_date
    ) s;

    -----------------------------------------------------------------
    -- COMPUTE AND RETURN RATIOS
    -----------------------------------------------------------------
    RETURN QUERY

    -- Current Ratio
    SELECT 'Current Ratio',
           CASE WHEN v_current_liabilities = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_current_assets / v_current_liabilities, 4) END,
           v_current_assets,
           v_current_liabilities,
           'Current Assets / Current Liabilities',
           CASE WHEN v_current_liabilities = 0 THEN 'N/A'
                WHEN v_current_assets / v_current_liabilities >= 1.5 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Quick Ratio (Acid Test)
    SELECT 'Quick Ratio',
           CASE WHEN v_current_liabilities = 0 THEN NULL::NUMERIC
                ELSE ROUND((v_cash + (v_current_assets - v_inventory - v_cash)) / v_current_liabilities, 4) END,
           v_cash + (v_current_assets - v_inventory - v_cash),
           v_current_liabilities,
           '(Cash + Receivables) / Current Liabilities',
           CASE WHEN v_current_liabilities = 0 THEN 'N/A'
                WHEN (v_cash + (v_current_assets - v_inventory - v_cash)) / v_current_liabilities >= 1.0 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Debt-to-Equity Ratio
    SELECT 'Debt-to-Equity',
           CASE WHEN v_total_equity = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_total_liabilities / v_total_equity, 4) END,
           v_total_liabilities,
           v_total_equity,
           'Total Liabilities / Total Equity',
           CASE WHEN v_total_equity = 0 THEN 'N/A'
                WHEN v_total_liabilities / v_total_equity <= 2.0 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Debt Ratio
    SELECT 'Debt Ratio',
           CASE WHEN v_total_assets = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_total_liabilities / v_total_assets, 4) END,
           v_total_liabilities,
           v_total_assets,
           'Total Liabilities / Total Assets',
           CASE WHEN v_total_assets = 0 THEN 'N/A'
                WHEN v_total_liabilities / v_total_assets <= 0.5 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Net Profit Margin (%)
    SELECT 'Net Profit Margin',
           CASE WHEN v_total_revenue = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_net_income / v_total_revenue * 100, 4) END,
           v_net_income,
           v_total_revenue,
           'Net Income / Revenue * 100',
           CASE WHEN v_total_revenue = 0 THEN 'N/A'
                WHEN v_net_income / v_total_revenue >= 0.10 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Gross Profit Margin
    SELECT 'Gross Profit Margin',
           CASE WHEN v_total_revenue = 0 THEN NULL::NUMERIC
                ELSE ROUND((v_total_revenue - v_cogs) / v_total_revenue * 100, 4) END,
           v_total_revenue - v_cogs,
           v_total_revenue,
           '(Revenue - COGS) / Revenue * 100',
           CASE WHEN v_total_revenue = 0 THEN 'N/A'
                WHEN (v_total_revenue - v_cogs) / v_total_revenue >= 0.30 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Inventory Turnover Ratio
    SELECT 'Inventory Turnover',
           CASE WHEN v_inventory = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_cogs / v_inventory, 4) END,
           v_cogs,
           v_inventory,
           'COGS / Average Inventory',
           CASE WHEN v_inventory = 0 THEN 'N/A'
                WHEN v_cogs / v_inventory >= 4.0 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Return on Equity (ROE)
    SELECT 'Return on Equity',
           CASE WHEN v_total_equity = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_net_income / v_total_equity * 100, 4) END,
           v_net_income,
           v_total_equity,
           'Net Income / Total Equity * 100',
           CASE WHEN v_total_equity = 0 THEN 'N/A'
                WHEN v_net_income / v_total_equity >= 0.15 THEN 'HEALTHY'
                ELSE 'RISK' END

    UNION ALL

    -- Return on Assets (ROA)
    SELECT 'Return on Assets',
           CASE WHEN v_total_assets = 0 THEN NULL::NUMERIC
                ELSE ROUND(v_net_income / v_total_assets * 100, 4) END,
           v_net_income,
           v_total_assets,
           'Net Income / Total Assets * 100',
           CASE WHEN v_total_assets = 0 THEN 'N/A'
                WHEN v_net_income / v_total_assets >= 0.05 THEN 'HEALTHY'
                ELSE 'RISK' END

    ORDER BY ratio_name;
END;
$$;


-------------------------------------------------------------------------------
-- 5. INVENTORY AGING REPORT (FIFO-based)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION generate_inventory_aging(
    p_tenant_id UUID
) RETURNS TABLE(
    stock_item_id   BIGINT,
    item_name       VARCHAR(200),
    batch_number    VARCHAR(100),
    aging_bucket    VARCHAR(20),
    total_qty       NUMERIC(18,4),
    total_value     NUMERIC(18,2),
    days_old_min    INT,
    days_old_max    INT
) LANGUAGE SQL STABLE AS $$

    WITH active_layers AS (
        SELECT
            sl.stock_item_id,
            si.item_name,
            COALESCE(ib.batch_number, '-')           AS batch_number,
            sl.remaining_quantity,
            sl.rate,
            sl.purchase_date,
            (CURRENT_DATE - sl.purchase_date)::INT    AS days_old,
            sl.remaining_quantity * sl.rate            AS layer_value
        FROM stock_layers sl
        JOIN stock_items si ON si.stock_item_id = sl.stock_item_id
        LEFT JOIN item_batches ib ON ib.batch_id = sl.batch_id
        WHERE sl.is_exhausted   = FALSE
          AND sl.remaining_quantity > 0
    ),

    classified AS (
        SELECT
            stock_item_id,
            item_name,
            batch_number,
            remaining_quantity,
            rate,
            layer_value,
            days_old,
            CASE
                WHEN days_old BETWEEN 0  AND 30  THEN '0-30 days'
                WHEN days_old BETWEEN 31 AND 60  THEN '31-60 days'
                WHEN days_old BETWEEN 61 AND 90  THEN '61-90 days'
                ELSE                                    '90+ days'
            END AS aging_bucket
        FROM active_layers
    )

    SELECT
        stock_item_id,
        item_name,
        batch_number,
        aging_bucket,
        SUM(remaining_quantity)     AS total_qty,
        SUM(layer_value)            AS total_value,
        MIN(days_old)               AS days_old_min,
        MAX(days_old)               AS days_old_max
    FROM classified
    GROUP BY stock_item_id, item_name, batch_number, aging_bucket
    ORDER BY
        CASE aging_bucket
            WHEN '0-30 days'  THEN 1
            WHEN '31-60 days' THEN 2
            WHEN '61-90 days' THEN 3
            ELSE                   4
        END,
        total_value DESC;
$$;


-- Dashboard summary variant: aggregates across all items per aging bucket
CREATE OR REPLACE FUNCTION generate_inventory_aging_summary(
    p_tenant_id UUID
) RETURNS TABLE(
    aging_bucket    VARCHAR(20),
    qty_on_hand     NUMERIC(18,4),
    value_at_risk   NUMERIC(18,2),
    item_count      BIGINT
) LANGUAGE SQL STABLE AS $$
    SELECT
        aging_bucket,
        SUM(total_qty)             AS qty_on_hand,
        SUM(total_value)           AS value_at_risk,
        COUNT(DISTINCT stock_item_id) AS item_count
    FROM generate_inventory_aging(p_tenant_id)
    GROUP BY aging_bucket
    ORDER BY
        CASE aging_bucket
            WHEN '0-30 days'  THEN 1
            WHEN '31-60 days' THEN 2
            WHEN '61-90 days' THEN 3
            ELSE                   4
        END;
$$;


-------------------------------------------------------------------------------
-- 6. MATERIALIZED VIEWS — Pre-computed for dashboard fast-path
-------------------------------------------------------------------------------

-- 6a. Dashboard Ratios MV — refreshed on journal posting events
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_dashboard_ratios AS
SELECT
    CURRENT_DATE                          AS as_of_date,
    cr.ratio_name,
    cr.ratio_value,
    cr.numerator,
    cr.denominator,
    cr.formula,
    cr.health
FROM calculate_financial_ratios(NULL::UUID, CURRENT_DATE) cr
WHERE 1 = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_ratios_unique
    ON mv_dashboard_ratios(as_of_date, ratio_name);


-- 6b. Inventory Aging Summary MV — refreshed on stock movement
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_inventory_aging_summary AS
SELECT * FROM generate_inventory_aging_summary(NULL::UUID)
WHERE 1 = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_aging_bucket
    ON mv_inventory_aging_summary(aging_bucket);


-------------------------------------------------------------------------------
-- 7. REFRESH FUNCTIONS — Called by the service layer after relevant mutations
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION analytics_refresh_ratios()
RETURNS VOID AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_ratios;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION analytics_refresh_inventory_aging()
RETURNS VOID AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_inventory_aging_summary;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION analytics_refresh_all()
RETURNS VOID AS $$
BEGIN
    PERFORM analytics_refresh_ratios();
    PERFORM analytics_refresh_inventory_aging();
END;
$$ LANGUAGE plpgsql;


-------------------------------------------------------------------------------
-- 8. ANALYTICS CACHE TABLE — Tracks when reports were last generated per tenant
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_cache_state (
    cache_key       VARCHAR(100) PRIMARY KEY,
    tenant_id       UUID         NOT NULL,
    report_type     VARCHAR(50)  NOT NULL,
    last_refreshed  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    next_scheduled  TIMESTAMPTZ,
    row_count       INT,
    compute_time_ms INT
);

CREATE INDEX IF NOT EXISTS idx_analytics_cache_tenant
    ON analytics_cache_state(tenant_id, report_type);


-------------------------------------------------------------------------------
-- 9. EXECUTIVE DASHBOARD SUMMARY — Single function returning all tiles
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_executive_dashboard(
    p_tenant_id UUID,
    p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'as_of_date',   p_as_of_date,
        'ratios',       (SELECT jsonb_agg(to_jsonb(r))
                         FROM calculate_financial_ratios(p_tenant_id, p_as_of_date) r),
        'inventory',    (SELECT jsonb_agg(to_jsonb(r))
                         FROM generate_inventory_aging_summary(p_tenant_id) r),
        'cash_flow',    (SELECT jsonb_agg(to_jsonb(r))
                         FROM generate_cash_flow_statement(
                             p_tenant_id,
                             (p_as_of_date - INTERVAL '1 month')::DATE,
                             p_as_of_date) r)
    ) INTO v_result;

    RETURN v_result;
END;
$$;
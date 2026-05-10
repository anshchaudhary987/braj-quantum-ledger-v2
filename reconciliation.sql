-- ============================================================================
-- RECONCILIATION & AUDIT VERIFICATION
-- Cross-check: journal_entries vs account_balances
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. Verify integrity for a single account
--    Compares the SUM of all journal_entries against the account_balances row.
--    Returns TRUE if they match, FALSE + details if they don't.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_account_balance(
    p_account_id     BIGINT,
    p_financial_year INT
)
RETURNS TABLE (
    account_id       BIGINT,
    account_name     TEXT,
    from_entries_debit   NUMERIC(18,2),
    from_entries_credit  NUMERIC(18,2),
    from_balances_debit  NUMERIC(18,2),
    from_balances_credit NUMERIC(18,2),
    debit_diff       NUMERIC(18,2),
    credit_diff      NUMERIC(18,2),
    is_valid         BOOLEAN,
    last_txn_date    DATE
) AS $$
DECLARE
    v_fy_start DATE := make_date(p_financial_year, 4, 1);
    v_fy_end   DATE := make_date(p_financial_year + 1, 3, 31);
BEGIN
    RETURN QUERY
    WITH je_agg AS (
        SELECT
            COALESCE(SUM(je.debit_amount),  0.00) AS total_debit,
            COALESCE(SUM(je.credit_amount), 0.00) AS total_credit,
            MAX(t.txn_date)                       AS last_date
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        WHERE je.account_id     = p_account_id
          AND t.txn_date       >= v_fy_start
          AND t.txn_date       <= v_fy_end
    ),
    bal AS (
        SELECT
            COALESCE(total_debits,  0.00) AS total_debit,
            COALESCE(total_credits, 0.00) AS total_credit
        FROM account_balances
        WHERE account_id      = p_account_id
          AND financial_year  = p_financial_year
    )
    SELECT
        p_account_id,
        a.account_name,
        je_agg.total_debit,
        je_agg.total_credit,
        COALESCE(bal.total_debit,  0.00),
        COALESCE(bal.total_credit, 0.00),
        je_agg.total_debit  - COALESCE(bal.total_debit,  0.00) AS debit_diff,
        je_agg.total_credit - COALESCE(bal.total_credit, 0.00) AS credit_diff,
        (je_agg.total_debit  = COALESCE(bal.total_debit,  0.00))
            AND (je_agg.total_credit = COALESCE(bal.total_credit, 0.00)),
        je_agg.last_date
    FROM accounts a, je_agg
    LEFT JOIN bal ON TRUE
    WHERE a.account_id = p_account_id;
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 2. Bulk verification — audit ALL accounts for a given financial year
--    Returns only mismatched accounts so auditors can focus on discrepancies.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_all_accounts(p_financial_year INT)
RETURNS TABLE (
    account_id   BIGINT,
    account_name TEXT,
    debit_diff   NUMERIC(18,2),
    credit_diff  NUMERIC(18,2)
) AS $$
DECLARE
    v_fy_start DATE := make_date(p_financial_year,     4, 1);
    v_fy_end   DATE := make_date(p_financial_year + 1, 3, 31);
BEGIN
    RETURN QUERY
    WITH je_agg AS (
        SELECT
            je.account_id,
            COALESCE(SUM(je.debit_amount),  0.00) AS total_debit,
            COALESCE(SUM(je.credit_amount), 0.00) AS total_credit
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        WHERE t.txn_date >= v_fy_start
          AND t.txn_date <= v_fy_end
        GROUP BY je.account_id
    )
    SELECT
        a.account_id,
        a.account_name,
        COALESCE(je_agg.total_debit,  0) - COALESCE(ab.total_debits,  0) AS debit_diff,
        COALESCE(je_agg.total_credit, 0) - COALESCE(ab.total_credits, 0) AS credit_diff
    FROM accounts a
    LEFT JOIN account_balances ab
        ON ab.account_id      = a.account_id
       AND ab.financial_year  = p_financial_year
    LEFT JOIN je_agg
        ON je_agg.account_id  = a.account_id
    WHERE a.is_active = TRUE
      AND (
          COALESCE(je_agg.total_debit,  0) <> COALESCE(ab.total_debits,  0)
          OR
          COALESCE(je_agg.total_credit, 0) <> COALESCE(ab.total_credits, 0)
      );
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 3. Rebuild account_balances from scratch (disaster recovery / migration)
--    Truncates and recomputes every row from journal_entries.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebuild_account_balances(p_financial_year INT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_fy_start DATE;
    v_fy_end   DATE;
BEGIN
    IF p_financial_year IS NULL THEN
        -- Rebuild ALL years
        DELETE FROM account_balances;

        INSERT INTO account_balances (account_id, financial_year, total_debits, total_credits, closing_balance)
        SELECT
            je.account_id,
            get_financial_year(t.txn_date),
            SUM(je.debit_amount),
            SUM(je.credit_amount),
            SUM(je.debit_amount) - SUM(je.credit_amount)
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        GROUP BY je.account_id, get_financial_year(t.txn_date);
    ELSE
        v_fy_start := make_date(p_financial_year,     4, 1);
        v_fy_end   := make_date(p_financial_year + 1, 3, 31);

        DELETE FROM account_balances WHERE financial_year = p_financial_year;

        INSERT INTO account_balances (account_id, financial_year, total_debits, total_credits, closing_balance)
        SELECT
            je.account_id,
            p_financial_year,
            SUM(je.debit_amount),
            SUM(je.credit_amount),
            SUM(je.debit_amount) - SUM(je.credit_amount)
        FROM journal_entries je
        JOIN transactions t ON t.transaction_id = je.transaction_id
        WHERE t.txn_date >= v_fy_start
          AND t.txn_date <= v_fy_end
        GROUP BY je.account_id;
    END IF;
END;
$$ LANGUAGE plpgsql;
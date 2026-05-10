-- ============================================================================
-- BILL-WISE DETAILS — Accounts Receivable / Payable Tracking (Tally-style)
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. PARTY LEDGER EXTENSIONS — Credit limits and payment terms on accounts
-------------------------------------------------------------------------------
-- Adds credit_days, credit_limit, and is_party_ledger to the accounts table.
-- Party ledgers = Sundry Debtors (Customers) and Sundry Creditors (Vendors).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_days      INT          DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_limit     NUMERIC(18,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_party_ledger  BOOLEAN      DEFAULT FALSE;

COMMENT ON COLUMN accounts.credit_days    IS 'Payment terms in days. due_date = bill_date + credit_days.';
COMMENT ON COLUMN accounts.credit_limit   IS 'Maximum outstanding exposure. NULL = no limit.';
COMMENT ON COLUMN accounts.is_party_ledger IS 'Marks Sundry Debtors / Sundry Creditors for party-specific features.';

-- Index for party-specific queries
CREATE INDEX IF NOT EXISTS idx_accounts_party ON accounts(account_id)
    WHERE is_party_ledger = TRUE;

-------------------------------------------------------------------------------
-- 2. BILL REFERENCES — Core bill-wise tracking table
-------------------------------------------------------------------------------
CREATE TABLE bill_references (
    bill_ref_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id            BIGINT       NOT NULL,

    -- Link to the accounting lines this bill/payment created
    transaction_id        BIGINT       NOT NULL REFERENCES transactions(transaction_id),
    journal_entry_id      BIGINT       NOT NULL REFERENCES journal_entries(entry_id),

    -- The party (customer or vendor) ledger account
    ledger_account_id     BIGINT       NOT NULL REFERENCES accounts(account_id),

    -- 4 Reference Types (Tally-style):
    --   NEW_REF    = Creating a new bill/invoice (sets up a receivable/payable)
    --   AGST_REF   = Payment/adjustment against an existing bill
    --   ADVANCE    = Money received/paid before the invoice exists
    --   ON_ACCOUNT = Lump sum payment without specific bill reference
    reference_type        VARCHAR(20)  NOT NULL
                          CHECK (reference_type IN ('NEW_REF', 'AGST_REF', 'ADVANCE', 'ON_ACCOUNT')),

    -- Bill identity (for NEW_REF)
    bill_number           VARCHAR(100),                   -- e.g. 'INV-001', 'BILL-2026-042'
    bill_date             DATE,
    due_date              DATE,                           -- bill_date + credit_days
    bill_description      TEXT,

    -- Amount tracking
    original_amount       NUMERIC(18,2) NOT NULL,          -- total bill face value
    pending_amount        NUMERIC(18,2) NOT NULL,          -- remaining to be settled
    settled_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,-- what has been adjusted so far

    -- For AGST_REF: which bill is this payment adjusting?
    adjusted_against_bill_ref_id BIGINT REFERENCES bill_references(bill_ref_id),
    adjustment_amount     NUMERIC(18,2),                   -- how much is being adjusted in THIS entry

    -- For ADVANCE: flag that it can be adjusted against future bills
    is_advance_available  BOOLEAN       NOT NULL DEFAULT FALSE,

    -- Lifecycle
    status                VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN (
                              'PENDING',           -- bill created, nothing paid yet
                              'PARTIALLY_PAID',    -- some amount adjusted, balance remains
                              'SETTLED',           -- fully adjusted, pending = 0
                              'CANCELLED',         -- bill voided, no longer collectible
                              'ADVANCE_PENDING',   -- advance received, not yet consumed
                              'ADVANCE_CONSUMED'   -- advance fully utilized
                          )),

    -- Audit
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Indexes for the adjustment workflow and aging queries
CREATE INDEX idx_bill_ref_ledger_status
    ON bill_references(ledger_account_id, status, pending_amount)
    WHERE pending_amount > 0;

CREATE INDEX idx_bill_ref_parent
    ON bill_references(adjusted_against_bill_ref_id);

-- Composite index for aging report (bill date + pending)
CREATE INDEX idx_bill_ref_aging
    ON bill_references(company_id, ledger_account_id, due_date, pending_amount)
    WHERE status IN ('PENDING', 'PARTIALLY_PAID') AND pending_amount > 0;

-------------------------------------------------------------------------------
-- 3. PENDING BILLS VIEW — Real-time snapshot of outstanding receivables/payables
-------------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_pending_bills AS
SELECT
    br.bill_ref_id,
    br.company_id,
    br.bill_number,
    br.bill_date,
    br.due_date,
    br.bill_description,
    br.reference_type,
    br.ledger_account_id,
    a.account_name              AS party_name,
    a.account_code              AS party_code,
    a.credit_days,
    a.credit_limit,
    br.original_amount,
    br.pending_amount,
    br.settled_amount,
    br.status,
    (CURRENT_DATE - br.due_date) AS days_overdue,
    CASE
        WHEN br.due_date >= CURRENT_DATE                          THEN 'NOT_DUE'
        WHEN CURRENT_DATE - br.due_date BETWEEN  1 AND 30  THEN '0_30_DAYS'
        WHEN CURRENT_DATE - br.due_date BETWEEN 31 AND 60  THEN '31_60_DAYS'
        WHEN CURRENT_DATE - br.due_date BETWEEN 61 AND 90  THEN '61_90_DAYS'
        WHEN CURRENT_DATE - br.due_date BETWEEN 91 AND 180 THEN '91_180_DAYS'
        ELSE 'OVER_180_DAYS'
    END AS aging_bucket
FROM bill_references br
JOIN accounts a ON a.account_id = br.ledger_account_id
WHERE br.reference_type IN ('NEW_REF', 'ADVANCE')
  AND br.status IN ('PENDING', 'PARTIALLY_PAID')
  AND br.pending_amount > 0
ORDER BY br.due_date ASC;

-------------------------------------------------------------------------------
-- 4. AGING REPORT FUNCTION — Parameterised aging query
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_bill_aging_report(
    p_company_id  BIGINT,
    p_as_of_date  DATE DEFAULT CURRENT_DATE,
    p_account_id  BIGINT DEFAULT NULL     -- optional: filter by a single party
)
RETURNS TABLE (
    party_name        TEXT,
    party_code        VARCHAR(50),
    total_outstanding NUMERIC(18,2),
    not_due           NUMERIC(18,2),
    days_0_30         NUMERIC(18,2),
    days_31_60        NUMERIC(18,2),
    days_61_90        NUMERIC(18,2),
    days_91_180       NUMERIC(18,2),
    days_over_180     NUMERIC(18,2)
) AS $$
BEGIN
    RETURN QUERY
    WITH aged AS (
        SELECT
            a.account_name,
            a.account_code,
            a.account_id,
            COALESCE(br.pending_amount, 0) AS pending,
            CASE
                WHEN br.due_date >= p_as_of_date                                          THEN 'not_due'
                WHEN p_as_of_date - br.due_date BETWEEN 1 AND 30                    THEN 'd_0_30'
                WHEN p_as_of_date - br.due_date BETWEEN 31 AND 60                   THEN 'd_31_60'
                WHEN p_as_of_date - br.due_date BETWEEN 61 AND 90                   THEN 'd_61_90'
                WHEN p_as_of_date - br.due_date BETWEEN 91 AND 180                  THEN 'd_91_180'
                ELSE 'd_over_180'
            END AS bucket
        FROM accounts a
        LEFT JOIN bill_references br
            ON br.ledger_account_id = a.account_id
           AND br.company_id        = p_company_id
           AND br.reference_type   IN ('NEW_REF', 'ADVANCE')
           AND br.status           IN ('PENDING', 'PARTIALLY_PAID')
           AND br.pending_amount    > 0
        WHERE a.company_id        = p_company_id
          AND a.is_party_ledger   = TRUE
          AND (p_account_id IS NULL OR a.account_id = p_account_id)
    )
    SELECT
        aged.account_name::TEXT,
        aged.account_code,
        COALESCE(SUM(aged.pending), 0)::NUMERIC(18,2),
        COALESCE(SUM(aged.pending) FILTER (WHERE aged.bucket = 'not_due'),    0)::NUMERIC(18,2),
        COALESCE(SUM(aged.pending) FILTER (WHERE aged.bucket = 'd_0_30'),     0)::NUMERIC(18,2),
        COALESCE(SUM(aged.pending) FILTER (WHERE aged.bucket = 'd_31_60'),    0)::NUMERIC(18,2),
        COALESCE(SUM(aged.pending) FILTER (WHERE aged.bucket = 'd_61_90'),    0)::NUMERIC(18,2),
        COALESCE(SUM(aged.pending) FILTER (WHERE aged.bucket = 'd_91_180'),   0)::NUMERIC(18,2),
        COALESCE(SUM(aged.pending) FILTER (WHERE aged.bucket = 'd_over_180'), 0)::NUMERIC(18,2)
    FROM aged
    GROUP BY aged.account_name, aged.account_code, aged.account_id
    HAVING COALESCE(SUM(aged.pending), 0) > 0
    ORDER BY aged.account_name;
END;
$$ LANGUAGE plpgsql STABLE;

-------------------------------------------------------------------------------
-- 5. CREDIT LIMIT VALIDATION FUNCTION
--    Called before inserting a NEW_REF bill to check if the party has
--    exceeded credit_days or credit_limit.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_credit_limit(
    p_ledger_account_id BIGINT,
    p_new_bill_amount   NUMERIC(18,2),
    p_company_id        BIGINT
)
RETURNS TABLE (
    is_valid         BOOLEAN,
    current_exposure NUMERIC(18,2),
    credit_limit     NUMERIC(18,2),
    warning_message  TEXT
) AS $$
DECLARE
    v_credit_limit     NUMERIC(18,2);
    v_credit_days      INT;
    v_total_pending    NUMERIC(18,2);
    v_total_exposure   NUMERIC(18,2);
    v_overdue_count    INT;
BEGIN
    -- Fetch the party's credit terms
    SELECT a.credit_limit, a.credit_days
    INTO v_credit_limit, v_credit_days
    FROM accounts a
    WHERE a.account_id  = p_ledger_account_id
      AND a.is_party_ledger = TRUE;

    -- Sum total pending from all open bills for this party
    SELECT COALESCE(SUM(br.pending_amount), 0)
    INTO v_total_pending
    FROM bill_references br
    WHERE br.ledger_account_id = p_ledger_account_id
      AND br.company_id        = p_company_id
      AND br.reference_type   IN ('NEW_REF', 'ADVANCE')
      AND br.status           IN ('PENDING', 'PARTIALLY_PAID');

    v_total_exposure := v_total_pending + p_new_bill_amount;

    -- Count overdue bills
    SELECT COUNT(*)
    INTO v_overdue_count
    FROM bill_references br
    WHERE br.ledger_account_id = p_ledger_account_id
      AND br.company_id        = p_company_id
      AND br.reference_type   IN ('NEW_REF', 'ADVANCE')
      AND br.status           IN ('PENDING', 'PARTIALLY_PAID')
      AND br.due_date          < CURRENT_DATE
      AND br.pending_amount    > 0;

    -- Validate
    IF v_credit_limit IS NOT NULL AND v_total_exposure > v_credit_limit THEN
        RETURN QUERY SELECT
            FALSE,
            v_total_pending,
            v_credit_limit,
            ('Credit limit exceeded. Current exposure: ₹' || v_total_pending
             || ', new bill: ₹' || p_new_bill_amount
             || ', total: ₹' || v_total_exposure
             || ' (limit: ₹' || v_credit_limit || ')')::TEXT;
        RETURN;
    END IF;

    IF v_overdue_count > 0 THEN
        RETURN QUERY SELECT
            TRUE,  -- not blocking, just warning
            v_total_pending,
            COALESCE(v_credit_limit, 0),
            ('WARNING: Party has ' || v_overdue_count
             || ' overdue bill(s) beyond credit days (' || v_credit_days || ' days).')::TEXT;
        RETURN;
    END IF;

    -- Passed all checks
    RETURN QUERY SELECT TRUE, v_total_pending, COALESCE(v_credit_limit, 0), NULL::TEXT;
END;
$$ LANGUAGE plpgsql STABLE;
-- ============================================================================
-- COST CATEGORIES & COST CENTERS — Multi-Dimensional Accounting
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. COST CATEGORIES — Classification buckets
--    e.g. 'Branches', 'Projects', 'Departments', 'Employees'
-------------------------------------------------------------------------------
CREATE TABLE cost_categories (
    cost_category_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,
    category_name      VARCHAR(100) NOT NULL,
    description        TEXT,
    is_mandatory       BOOLEAN      NOT NULL DEFAULT FALSE,
    -- If TRUE, every journal_entry for relevant accounts MUST allocate to
    -- this category before the transaction can commit.

    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (company_id, category_name)
);

-------------------------------------------------------------------------------
-- 2. COST CENTERS — Individual nodes within a category
--    Hierarchical via parent_cost_center_id + materialized path (ltree)
--    e.g. Category='Projects' → Phase 1 → Task A
-------------------------------------------------------------------------------
CREATE TABLE cost_centers (
    cost_center_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,
    cost_category_id   BIGINT       NOT NULL REFERENCES cost_categories(cost_category_id),

    center_name        VARCHAR(200) NOT NULL,
    center_code        VARCHAR(50),

    -- Self-referencing hierarchy (optional)
    parent_cost_center_id BIGINT    REFERENCES cost_centers(cost_center_id),
    path                 LTREE     NOT NULL,    -- e.g. '1.5.12'

    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (company_id, cost_category_id, center_name)
);

CREATE INDEX idx_cost_centers_path        ON cost_centers USING GIST(path);
CREATE INDEX idx_cost_centers_category    ON cost_centers(cost_category_id);
CREATE INDEX idx_cost_centers_parent      ON cost_centers(parent_cost_center_id);

-------------------------------------------------------------------------------
-- 3. COST CENTER ALLOCATIONS — Links journal_entry → cost_center(s)
--    Every row allocates part (or all) of a single journal line to a cost center.
--    The 100% rule is enforced by trigger (see Section 5).
-------------------------------------------------------------------------------
CREATE TABLE cost_center_allocations (
    allocation_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,
    journal_entry_id   BIGINT       NOT NULL REFERENCES journal_entries(entry_id)
                                     ON DELETE CASCADE,
    cost_center_id     BIGINT       NOT NULL REFERENCES cost_centers(cost_center_id),

    allocated_amount   NUMERIC(18,2) NOT NULL CHECK (allocated_amount > 0),

    -- Audit
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast lookups: all allocations for a journal entry
CREATE INDEX idx_cca_journal_entry ON cost_center_allocations(journal_entry_id);

-- Fast lookups: all allocations for a cost center (reporting)
CREATE INDEX idx_cca_cost_center   ON cost_center_allocations(cost_center_id);

-------------------------------------------------------------------------------
-- 4. COST CENTER CLASSES — Auto-Allocation Rules
--    Defines automatic percentage splits when a specific ledger account
--    is used in a voucher.
-------------------------------------------------------------------------------
CREATE TABLE cost_center_classes (
    class_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,
    class_name         VARCHAR(200) NOT NULL,          -- e.g. 'Rent Split — Factory/Office'
    ledger_account_id  BIGINT       NOT NULL REFERENCES accounts(account_id),
    description        TEXT,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (company_id, ledger_account_id)             -- one rule per ledger account
);

-------------------------------------------------------------------------------
-- 4b. CLASS SPLITS — Individual percentage lines within a class
-------------------------------------------------------------------------------
CREATE TABLE cost_center_class_splits (
    split_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_id           BIGINT       NOT NULL REFERENCES cost_center_classes(class_id)
                                     ON DELETE CASCADE,
    cost_center_id     BIGINT       NOT NULL REFERENCES cost_centers(cost_center_id),
    split_percentage   NUMERIC(5,2) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),

    UNIQUE (class_id, cost_center_id)
);

-------------------------------------------------------------------------------
-- 5. 100% VALIDATION RULE — Trigger (cannot be bypassed by application bugs)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_enforce_cost_center_100pct()
RETURNS TRIGGER AS $$
DECLARE
    v_entry_amount   NUMERIC(18,2);
    v_total_alloc    NUMERIC(18,2);
    v_diff           NUMERIC(18,2);
    v_journal_id     BIGINT;
BEGIN
    -- Determine which journal entry is affected
    v_journal_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

    -- Get the total amount of this journal line (debit_amount or credit_amount)
    SELECT COALESCE(je.debit_amount, 0) + COALESCE(je.credit_amount, 0)
    INTO v_entry_amount
    FROM journal_entries je
    WHERE je.entry_id = v_journal_id;

    -- Sum all currently-persisted allocations for this journal entry
    SELECT COALESCE(SUM(cca.allocated_amount), 0)
    INTO v_total_alloc
    FROM cost_center_allocations cca
    WHERE cca.journal_entry_id = v_journal_id;

    v_diff := v_entry_amount - v_total_alloc;

    -- Tolerance of 0.02 (2 paisa) to handle rounding from percentage splits.
    -- For amounts like ₹100 split 33.33% × 3, total = 99.99.
    -- The application layer ensures the rounding diff is absorbed into the
    -- LAST allocation row so the trigger never sees a mismatch.
    IF ABS(v_diff) > 0.02 THEN
        RAISE EXCEPTION
            'Cost center allocation mismatch: Journal entry % has amount ₹%s, '
            'but total allocated is ₹%s. Difference: ₹%s. '
            'Allocations must sum to exactly 100%% of the journal line amount.',
            v_journal_id,
            to_char(v_entry_amount, 'FM9999999990.00'),
            to_char(v_total_alloc,  'FM9999999990.00'),
            to_char(v_diff,         'FM9999999990.00');
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deferrable: allows inserting 3 split rows for the same journal_entry
-- in one transaction before the check fires at COMMIT.
CREATE CONSTRAINT TRIGGER ctrg_cost_center_100pct
    AFTER INSERT OR UPDATE OF allocated_amount OR DELETE
    ON cost_center_allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_cost_center_100pct();

-------------------------------------------------------------------------------
-- 6. AUTO-ALLOCATION FUNCTION — Called during voucher creation
--    If a cost_center_class exists for the ledger account, auto-split.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_allocate_cost_centers(
    p_journal_entry_id BIGINT,
    p_company_id       BIGINT
)
RETURNS SETOF BIGINT AS $$           -- returns allocation IDs
DECLARE
    v_entry_amount     NUMERIC(18,2);
    v_account_id       BIGINT;
    v_class_id         BIGINT;
    v_split            RECORD;
    v_remaining        NUMERIC(18,2);
    v_rounded          NUMERIC(18,2);
    v_alloc_total      NUMERIC(18,2) := 0;
    v_first_split      BOOLEAN := TRUE;
    v_allocation_id    BIGINT;
    v_last_split_id    BIGINT;
    v_last_allocated   NUMERIC(18,2);
    v_sum_others       NUMERIC(18,2);
BEGIN
    -- Get journal entry amount and account
    SELECT COALESCE(je.debit_amount, 0) + COALESCE(je.credit_amount, 0),
           je.account_id
    INTO v_entry_amount, v_account_id
    FROM journal_entries je
    WHERE je.entry_id = p_journal_entry_id;

    IF v_entry_amount IS NULL THEN
        RETURN;
    END IF;

    -- Find an active cost_center_class for this ledger account
    SELECT cc.class_id INTO v_class_id
    FROM cost_center_classes cc
    WHERE cc.ledger_account_id = v_account_id
      AND cc.company_id        = p_company_id
      AND cc.is_active         = TRUE
    LIMIT 1;

    IF v_class_id IS NULL THEN
        RETURN;  -- No auto-allocation rule → user must allocate manually
    END IF;

    -- Iterate over splits, computing each allocation amount
    -- The LAST split absorbs the rounding error so total = 100% exactly.
    SELECT COUNT(*) INTO v_remaining FROM cost_center_class_splits WHERE class_id = v_class_id;

    FOR v_split IN
        SELECT split_id, cost_center_id, split_percentage
        FROM cost_center_class_splits
        WHERE class_id = v_class_id
        ORDER BY split_id
    LOOP
        v_remaining := v_remaining - 1;

        IF v_remaining > 0 THEN
            -- Normal rounding: percentage * amount / 100
            v_rounded := ROUND(v_entry_amount * v_split.split_percentage / 100, 2);
            v_alloc_total := v_alloc_total + v_rounded;
        ELSE
            -- LAST split: absorb all remaining to hit 100% exactly
            v_rounded := v_entry_amount - v_alloc_total;
        END IF;

        INSERT INTO cost_center_allocations
            (company_id, journal_entry_id, cost_center_id, allocated_amount)
        VALUES
            (p_company_id, p_journal_entry_id, v_split.cost_center_id, v_rounded)
        RETURNING allocation_id INTO v_allocation_id;

        RETURN NEXT v_allocation_id;
    END LOOP;

    RETURN;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- 7. REPORTING — Cost Center Breakup, Hierarchical Drill-down
-------------------------------------------------------------------------------

-- 7a. Single cost centre detail: all ledger expenses allocated to it
CREATE OR REPLACE FUNCTION get_cost_center_breakup(
    p_cost_center_id  BIGINT,
    p_from_date       DATE,
    p_to_date         DATE
)
RETURNS TABLE (
    ledger_account_name TEXT,
    ledger_account_code VARCHAR(50),
    total_allocated     NUMERIC(18,2),
    transaction_count   BIGINT,
    first_txn_date      DATE,
    last_txn_date       DATE
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        a.account_name::TEXT,
        a.account_code,
        SUM(cca.allocated_amount)::NUMERIC(18,2),
        COUNT(DISTINCT t.transaction_id)::BIGINT,
        MIN(t.txn_date),
        MAX(t.txn_date)
    FROM cost_center_allocations cca
    JOIN journal_entries je ON je.entry_id = cca.journal_entry_id
    JOIN accounts a         ON a.account_id = je.account_id
    JOIN transactions t     ON t.transaction_id = je.transaction_id
    WHERE cca.cost_center_id = p_cost_center_id
      AND t.txn_date BETWEEN p_from_date AND p_to_date
    GROUP BY a.account_name, a.account_code
    ORDER BY a.account_name;
END;
$$ LANGUAGE plpgsql STABLE;

-- 7b. Category-level: sums all centres under a given cost category
CREATE OR REPLACE FUNCTION get_cost_category_breakup(
    p_cost_category_id BIGINT,
    p_from_date        DATE,
    p_to_date          DATE
)
RETURNS TABLE (
    cost_center_name    TEXT,
    ledger_account_name TEXT,
    total_allocated     NUMERIC(18,2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cc.center_name::TEXT,
        a.account_name::TEXT,
        SUM(cca.allocated_amount)::NUMERIC(18,2)
    FROM cost_center_allocations cca
    JOIN cost_centers cc    ON cc.cost_center_id = cca.cost_center_id
    JOIN journal_entries je ON je.entry_id = cca.journal_entry_id
    JOIN accounts a         ON a.account_id = je.account_id
    JOIN transactions t     ON t.transaction_id = je.transaction_id
    WHERE cc.cost_category_id = p_cost_category_id
      AND t.txn_date BETWEEN p_from_date AND p_to_date
    GROUP BY cc.center_name, a.account_name
    ORDER BY cc.center_name, a.account_name;
END;
$$ LANGUAGE plpgsql STABLE;

-- 7c. Hierarchical drill-down: sums a parent cost centre + all its children
CREATE OR REPLACE FUNCTION get_cost_center_tree_breakup(
    p_parent_cost_center_id BIGINT,
    p_from_date             DATE,
    p_to_date               DATE
)
RETURNS TABLE (
    cost_center_name    TEXT,
    depth               INT,
    ledger_account_name TEXT,
    total_allocated     NUMERIC(18,2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cc.center_name::TEXT,
        nlevel(cc.path) - nlevel(parent.path) + 1 AS depth,
        a.account_name::TEXT,
        SUM(cca.allocated_amount)::NUMERIC(18,2)
    FROM cost_centers parent
    JOIN cost_centers cc     ON cc.path <@ (parent.path::TEXT || '.*')::lquery
    JOIN cost_center_allocations cca ON cca.cost_center_id = cc.cost_center_id
    JOIN journal_entries je  ON je.entry_id = cca.journal_entry_id
    JOIN accounts a          ON a.account_id = je.account_id
    JOIN transactions t      ON t.transaction_id = je.transaction_id
    WHERE parent.cost_center_id = p_parent_cost_center_id
      AND t.txn_date BETWEEN p_from_date AND p_to_date
    GROUP BY cc.center_name, cc.path, parent.path, a.account_name
    ORDER BY cc.path, a.account_name;
END;
$$ LANGUAGE plpgsql STABLE;
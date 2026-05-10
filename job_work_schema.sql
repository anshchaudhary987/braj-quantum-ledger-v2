-- ============================================================================
-- JOB WORK (SUB-CONTRACTING) — Stock lying with Third Parties
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. VIRTUAL GODOWNS — Link godowns to party ledgers
-------------------------------------------------------------------------------
-- Adds godown_type and party_account_id so each vendor gets a virtual godown.
-- Stock lying with Vendor ABC = stock_valuations WHERE godown_id = ABC's virtual godown.
ALTER TABLE godowns ADD COLUMN IF NOT EXISTS godown_type VARCHAR(20) NOT NULL DEFAULT 'PHYSICAL'
    CHECK (godown_type IN ('PHYSICAL', 'VIRTUAL'));
ALTER TABLE godowns ADD COLUMN IF NOT EXISTS party_account_id BIGINT REFERENCES accounts(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_godown_party ON godowns(party_account_id)
    WHERE party_account_id IS NOT NULL AND godown_type = 'VIRTUAL';

-- New stock transaction types for job work
-- Note: This modifies the existing CHECK constraint on stock_transactions.
-- In production, this requires dropping and recreating the constraint.
-- Listed here for documentation; the seed file runs the actual migration.
COMMENT ON TABLE stock_transactions IS
    'transaction_type includes: JOB_WORK_SEND, JOB_WORK_RECEIVE, JOB_WORK_SCRAP';

-------------------------------------------------------------------------------
-- 2. DELIVERY CHALLANS — Non-accounting vouchers for material movement
-------------------------------------------------------------------------------
CREATE TABLE delivery_challans (
    challan_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id             BIGINT       NOT NULL,

    challan_type           VARCHAR(15)  NOT NULL
                           CHECK (challan_type IN ('JOB_WORK_OUT', 'JOB_WORK_IN')),
    challan_number         VARCHAR(50)  NOT NULL,
    challan_date           DATE         NOT NULL,

    -- The job worker (vendor)
    vendor_account_id      BIGINT       NOT NULL REFERENCES accounts(account_id),
    vendor_godown_id       BIGINT       NOT NULL REFERENCES godowns(godown_id),

    -- For JOB_WORK_IN: which OUT challan is being reconciled?
    reference_challan_id   BIGINT       REFERENCES delivery_challans(challan_id),

    -- Status tracking
    status                 VARCHAR(20)  NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN (
                               'DRAFT', 'SENT', 'PARTIALLY_RECEIVED',
                               'COMPLETED', 'CANCELLED'
                           )),

    -- Accounting linkage — when service invoice is posted
    is_accounted           BOOLEAN      NOT NULL DEFAULT FALSE,
    service_transaction_id BIGINT       REFERENCES transactions(transaction_id),
    -- The service invoice for the vendor's labour charges

    narration              TEXT,
    metadata               JSONB        NOT NULL DEFAULT '{}'::jsonb,

    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_challans_vendor ON delivery_challans(vendor_account_id, status, challan_date);
CREATE INDEX idx_challans_ref     ON delivery_challans(reference_challan_id);

-------------------------------------------------------------------------------
-- 3. CHALLAN ITEMS — Line items sent/received
-------------------------------------------------------------------------------
CREATE TABLE delivery_challan_items (
    challan_item_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    challan_id             BIGINT       NOT NULL REFERENCES delivery_challans(challan_id) ON DELETE CASCADE,

    stock_item_id          BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),

    -- Item role in this job work transaction
    item_type              VARCHAR(20)  NOT NULL
                           CHECK (item_type IN (
                               'RAW_MATERIAL',    -- material sent to vendor
                               'FINISHED_GOOD',   -- processed item coming back
                               'SCRAP',           -- waste material
                               'BY_PRODUCT',      -- secondary output
                               'PACKING',         -- packing material sent
                               'CONSUMABLE'       -- consumables used by vendor
                           )),

    -- For OUT challan: quantity being sent
    -- For IN challan: quantity received / consumed
    quantity               NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
    uom_id                 BIGINT       NOT NULL REFERENCES uom(uom_id),

    -- For partial receipts: how much of the OUT item has been received back
    received_quantity      NUMERIC(18,4) NOT NULL DEFAULT 0,

    -- Valuation (informational — not accounting; actual cost via WAC)
    rate                   NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Links to the actual stock movement (for full audit trail)
    send_stock_txn_id      BIGINT       REFERENCES stock_transactions(stock_txn_id),
    receive_stock_txn_id   BIGINT       REFERENCES stock_transactions(stock_txn_id),

    -- Scrap tracking
    expected_scrap_pct     NUMERIC(5,2),          -- expected wastage %
    actual_scrap_quantity  NUMERIC(18,4),

    narration              TEXT,

    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_challan_items_challan ON delivery_challan_items(challan_id);

-------------------------------------------------------------------------------
-- 4. JOB WORK RECONCILIATION VIEW — What's lying with each vendor?
-------------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_job_work_stock_with_vendor AS
SELECT
    g.godown_id,
    g.godown_name,
    g.party_account_id,
    a.account_name              AS vendor_name,
    si.stock_item_id,
    si.item_name,
    si.item_code,
    sv.total_quantity           AS quantity_with_vendor,
    sv.total_value              AS value_with_vendor,
    sv.current_wac,
    sv.updated_at               AS last_movement
FROM godowns g
JOIN accounts a             ON a.account_id = g.party_account_id
JOIN stock_valuations sv    ON sv.godown_id = g.godown_id
JOIN stock_items si         ON si.stock_item_id = sv.stock_item_id
WHERE g.godown_type = 'VIRTUAL'
  AND sv.total_quantity > 0
ORDER BY a.account_name, si.item_name;

-------------------------------------------------------------------------------
-- 5. RECONCILIATION FUNCTION — Compute yield and scrap for a JOB_WORK_IN
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_job_work_yield(
    p_in_challan_id    BIGINT
)
RETURNS TABLE (
    stock_item_id      BIGINT,
    item_name          TEXT,
    item_type          TEXT,
    quantity_sent      NUMERIC(18,4),
    quantity_received  NUMERIC(18,4),
    quantity_pending   NUMERIC(18,4),
    scrap_generated    NUMERIC(18,4),
    yield_pct          NUMERIC(5,2)
) AS $$
DECLARE
    v_out_challan_id BIGINT;
BEGIN
    -- Find the linked OUT challan
    SELECT dc.reference_challan_id INTO v_out_challan_id
    FROM delivery_challans dc
    WHERE dc.challan_id = p_in_challan_id;

    RETURN QUERY
    SELECT
        dci_out.stock_item_id,
        si.item_name::TEXT,
        dci_out.item_type::TEXT,
        dci_out.quantity,
        COALESCE(dci_in.received_quantity, 0),
        dci_out.quantity - COALESCE(dci_in.received_quantity, 0),
        COALESCE(dci_in.actual_scrap_quantity, 0),
        CASE WHEN dci_out.quantity > 0 THEN
            ROUND((COALESCE(dci_in.received_quantity, 0) / dci_out.quantity) * 100, 2)
        ELSE 0 END
    FROM delivery_challan_items dci_out
    JOIN stock_items si ON si.stock_item_id = dci_out.stock_item_id
    LEFT JOIN delivery_challan_items dci_in
        ON dci_in.challan_id   = p_in_challan_id
       AND dci_in.stock_item_id = dci_out.stock_item_id
       AND dci_in.item_type     = dci_out.item_type
    WHERE dci_out.challan_id = v_out_challan_id;
END;
$$ LANGUAGE plpgsql STABLE;
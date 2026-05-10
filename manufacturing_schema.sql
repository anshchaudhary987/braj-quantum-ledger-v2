-- ============================================================================
-- BILL OF MATERIALS + MANUFACTURING JOURNALS + OVERHEAD ALLOCATION
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. BILL OF MATERIALS (BOM) — Defines what goes into a Finished Good
-------------------------------------------------------------------------------
CREATE TABLE boms (
    bom_id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id           BIGINT       NOT NULL,

    bom_name             VARCHAR(200) NOT NULL,
    bom_code             VARCHAR(50),

    -- The finished good this BOM produces
    finished_good_item_id BIGINT      NOT NULL REFERENCES stock_items(stock_item_id),
    base_output_quantity NUMERIC(18,4) NOT NULL DEFAULT 1
                         CHECK (base_output_quantity > 0),
    -- "For 1 unit of finished good, use these quantities of raw materials"

    effective_from       DATE         NOT NULL DEFAULT CURRENT_DATE,
    effective_to         DATE,                                -- NULL = currently active

    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (company_id, bom_code)
);

CREATE TABLE bom_items (
    bom_item_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bom_id               BIGINT       NOT NULL REFERENCES boms(bom_id) ON DELETE CASCADE,

    -- The component: can be a raw material OR a by-product
    stock_item_id        BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),

    item_type            VARCHAR(15)  NOT NULL DEFAULT 'RAW_MATERIAL'
                         CHECK (item_type IN ('RAW_MATERIAL', 'BY_PRODUCT', 'CO_PRODUCT')),

    -- Quantity per base_output_quantity of finished good
    required_quantity    NUMERIC(18,4) NOT NULL CHECK (required_quantity > 0),
    uom_id               BIGINT       NOT NULL REFERENCES uom(uom_id),

    -- Wastage / scrap
    scrap_percentage     NUMERIC(5,2) NOT NULL DEFAULT 0
                         CHECK (scrap_percentage >= 0 AND scrap_percentage <= 100),

    -- Sequence for display ordering
    sort_order           INT          NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_bom_items_bom ON bom_items(bom_id);

-------------------------------------------------------------------------------
-- 2. MANUFACTURING JOURNALS — Track production runs
-------------------------------------------------------------------------------
CREATE TABLE manufacturing_journals (
    mfg_journal_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id           BIGINT       NOT NULL,

    -- Links to the accounting + inventory transactions
    transaction_id       BIGINT       NOT NULL REFERENCES transactions(transaction_id),

    bom_id               BIGINT       NOT NULL REFERENCES boms(bom_id),
    finished_good_item_id BIGINT      NOT NULL REFERENCES stock_items(stock_item_id),

    quantity_produced    NUMERIC(18,4) NOT NULL CHECK (quantity_produced > 0),
    godown_id            BIGINT       NOT NULL REFERENCES godowns(godown_id),

    production_date      DATE         NOT NULL,
    narration            TEXT,

    -- Cost summary (computed during processing)
    total_raw_material_cost  NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_overhead_cost      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_by_product_value   NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_fg_cost            NUMERIC(18,2) NOT NULL DEFAULT 0,
    -- unit_cost = (total_raw_material_cost + total_overhead - total_by_product_value) / quantity_produced
    unit_cost                NUMERIC(18,2) NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_mfg_journal_date ON manufacturing_journals(company_id, production_date);

-------------------------------------------------------------------------------
-- 2b. MFG JOURNAL ITEMS — Detailed consumption/production per component
-------------------------------------------------------------------------------
CREATE TABLE mfg_journal_items (
    mfg_journal_item_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mfg_journal_id       BIGINT       NOT NULL REFERENCES manufacturing_journals(mfg_journal_id),

    stock_item_id        BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),
    item_type            VARCHAR(15)  NOT NULL,  -- 'RAW_MATERIAL', 'BY_PRODUCT', 'FINISHED_GOOD', 'CO_PRODUCT'

    quantity             NUMERIC(18,4) NOT NULL,
    uom_id               BIGINT       NOT NULL REFERENCES uom(uom_id),
    rate                 NUMERIC(18,2) NOT NULL,  -- unit cost/credit applied
    total_amount         NUMERIC(18,2) NOT NULL,  -- qty × rate

    stock_txn_id         BIGINT       REFERENCES stock_transactions(stock_txn_id),

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- 3. OVERHEAD COSTS — Additional costs allocated to a manufacturing run
-------------------------------------------------------------------------------
CREATE TABLE manufacturing_overhead (
    overhead_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mfg_journal_id       BIGINT       NOT NULL REFERENCES manufacturing_journals(mfg_journal_id),

    cost_type            VARCHAR(50)  NOT NULL,       -- 'LABOUR', 'ELECTRICITY', 'MACHINE_HOURS', 'OTHER'
    cost_description     TEXT,
    cost_amount          NUMERIC(18,2) NOT NULL CHECK (cost_amount > 0),

    -- Allocation method
    allocation_method    VARCHAR(20)  NOT NULL DEFAULT 'PER_UNIT'
                         CHECK (allocation_method IN (
                             'PER_UNIT',               -- cost / quantity_produced per unit
                             'FIXED_TOTAL',            -- entire cost added to total FG value
                             'PERCENTAGE_OF_MATERIAL'  -- percentage of raw material cost
                         )),
    allocation_percentage NUMERIC(5,2),                -- only for PERCENTAGE_OF_MATERIAL

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
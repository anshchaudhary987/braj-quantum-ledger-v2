-- ============================================================================
-- INVENTORY MANAGEMENT SYSTEM — Integrated with Core Ledger
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. UNITS OF MEASURE (UOM) — Simple + Compound
-------------------------------------------------------------------------------
-- Approach: Every UOM defines a conversion_factor relative to the item's
-- base UOM. The "compound" relationship is implicit: Box(100) / Pack(10) = 10.
-- This avoids recursive chains and rounding errors.
--
-- Example:
--   Pieces (base):  uom_id=1, base_uom_id=NULL,   conversion_factor=1
--   Pack:           uom_id=2, base_uom_id=1,      conversion_factor=10
--   Box:            uom_id=3, base_uom_id=1,      conversion_factor=100
--   Dozen:          uom_id=4, base_uom_id=1,      conversion_factor=12
--   Gross:          uom_id=5, base_uom_id=1,      conversion_factor=144
--
-- All conversions go through the base unit:
--   2 Boxes → base:   2 × 100  = 200 Pieces
--   200 Pieces → Pack: 200 ÷ 10  = 20 Packs
-------------------------------------------------------------------------------
CREATE TABLE uom (
    uom_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uom_name            VARCHAR(50)  NOT NULL,         -- e.g. 'Pieces','Kilograms'
    symbol              VARCHAR(10)  NOT NULL,         -- e.g. 'Pcs','Kg','Box'
    base_uom_id         BIGINT       REFERENCES uom(uom_id),
    conversion_factor   NUMERIC(18,4) NOT NULL DEFAULT 1
                        CHECK (conversion_factor > 0),
    formal_name         VARCHAR(100),
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_uom_base ON uom(base_uom_id);

-------------------------------------------------------------------------------
-- 2. STOCK HIERARCHY — Groups → Categories → Items
-------------------------------------------------------------------------------
CREATE TABLE stock_groups (
    stock_group_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_name      VARCHAR(100) NOT NULL,
    parent_id       BIGINT       REFERENCES stock_groups(stock_group_id),
    path            LTREE        NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_groups_path ON stock_groups USING GIST(path);

CREATE TABLE stock_categories (
    stock_category_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_group_id    BIGINT       NOT NULL REFERENCES stock_groups(stock_group_id),
    category_name     VARCHAR(100) NOT NULL,
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_categories_group ON stock_categories(stock_group_id);

CREATE TABLE stock_items (
    stock_item_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_category_id BIGINT       NOT NULL REFERENCES stock_categories(stock_category_id),
    item_name         VARCHAR(200) NOT NULL,
    item_code         VARCHAR(50)  NOT NULL UNIQUE,

    -- UOM linkage — base_uom_id is the smallest saleable unit for this item
    base_uom_id       BIGINT       NOT NULL REFERENCES uom(uom_id),
    purchase_uom_id   BIGINT       REFERENCES uom(uom_id),    -- default purchase UOM
    sales_uom_id      BIGINT       REFERENCES uom(uom_id),    -- default sales UOM

    -- Valuation method — per-item configurability
    valuation_method  VARCHAR(20)  NOT NULL DEFAULT 'WEIGHTED_AVERAGE'
                      CHECK (valuation_method IN ('FIFO', 'WEIGHTED_AVERAGE')),

    -- Opening stock (migration / year-start)
    opening_quantity  NUMERIC(18,4) NOT NULL DEFAULT 0,
    opening_rate      NUMERIC(18,2) NOT NULL DEFAULT 0,
    opening_value     NUMERIC(18,2) GENERATED ALWAYS AS
                      (opening_quantity * opening_rate) STORED,

    -- Accounting linkage — which ledger account represents this inventory asset
    stock_ledger_account_id BIGINT REFERENCES accounts(account_id),

    is_tracked_by_batch  BOOLEAN NOT NULL DEFAULT FALSE,
    is_tracked_by_serial BOOLEAN NOT NULL DEFAULT FALSE,

    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_items_category ON stock_items(stock_category_id);
CREATE INDEX idx_stock_items_code     ON stock_items(item_code);

-------------------------------------------------------------------------------
-- 3. GODOWNS (Warehouses / Storage Locations)
-------------------------------------------------------------------------------
CREATE TABLE godowns (
    godown_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    godown_name   VARCHAR(100) NOT NULL,
    godown_code   VARCHAR(20)  NOT NULL UNIQUE,
    address_line1 VARCHAR(200),
    address_line2 VARCHAR(200),
    city          VARCHAR(100),
    state         VARCHAR(100),
    pincode       VARCHAR(10),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- 4. STOCK LEDGER — Atomic in/out, linked to accounting journal
-------------------------------------------------------------------------------
-- Every row links to a transaction_id (the accounting transaction header).
-- This is the native integration: stock movement ↔ accounting entry in the
-- same database transaction.
-------------------------------------------------------------------------------
CREATE TABLE stock_transactions (
    stock_txn_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Link to the ACCOUNTING transaction (the native bridge)
    transaction_id   BIGINT NOT NULL
                     REFERENCES transactions(transaction_id)
                     ON DELETE RESTRICT,

    -- Direct link to a specific journal line for precise audit trail
    journal_entry_id BIGINT REFERENCES journal_entries(entry_id),

    transaction_type VARCHAR(20) NOT NULL
                     CHECK (transaction_type IN (
                         'PURCHASE', 'PURCHASE_RETURN',
                         'SALES',    'SALES_RETURN',
                         'TRANSFER_IN', 'TRANSFER_OUT',
                         'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
                         'PRODUCTION_IN', 'PRODUCTION_OUT',
                         'OPENING_STOCK'
                     )),

    item_id          BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),
    godown_id        BIGINT       NOT NULL REFERENCES godowns(godown_id),

    -- Quantities always stored in the item's base UOM. Conversion from user-
    -- supplied UOM happens in the service layer before INSERT.
    quantity_in      NUMERIC(18,4) NOT NULL DEFAULT 0
                     CHECK (quantity_in >= 0),
    quantity_out     NUMERIC(18,4) NOT NULL DEFAULT 0
                     CHECK (quantity_out >= 0),

    -- Exactly one of quantity_in / quantity_out must be > 0
    CONSTRAINT chk_one_direction CHECK (
        (quantity_in > 0 AND quantity_out = 0)
        OR
        (quantity_out > 0 AND quantity_in = 0)
    ),

    rate             NUMERIC(18,2) NOT NULL DEFAULT 0,
    amount           NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- UOM context — what the user originally entered (for display)
    uom_id           BIGINT       NOT NULL REFERENCES uom(uom_id),
    uom_quantity     NUMERIC(18,4) NOT NULL,  -- user-entered qty in this UOM

    -- Optional: link to purchase/sales order
    reference_type   VARCHAR(50),              -- e.g. 'PURCHASE_ORDER', 'SALES_INVOICE'
    reference_id     VARCHAR(100),             -- order/invoice number

    narration        TEXT,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast stock ledger queries: item + godown + date range
CREATE INDEX idx_stock_txn_item_godown_date
    ON stock_transactions(item_id, godown_id, created_at)
    INCLUDE (quantity_in, quantity_out, rate, transaction_type);

-- Trace stock movements to accounting entries
CREATE INDEX idx_stock_txn_journal ON stock_transactions(journal_entry_id);

-- Accounting → inventory trace
CREATE INDEX idx_stock_txn_accounting ON stock_transactions(transaction_id);

-------------------------------------------------------------------------------
-- 5. BATCH TRACKING — Flexible, optional per item
-------------------------------------------------------------------------------
CREATE TABLE item_batches (
    batch_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_item_id       BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),
    batch_number        VARCHAR(100) NOT NULL,
    manufacturing_date  DATE,
    expiry_date         DATE,
    mrp                 NUMERIC(18,2),
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_batch UNIQUE (stock_item_id, batch_number)
);

CREATE INDEX idx_batches_item_expiry ON item_batches(stock_item_id, expiry_date)
    WHERE expiry_date IS NOT NULL;

-------------------------------------------------------------------------------
-- 6. SERIAL NUMBER TRACKING — Flexible, optional per item
-------------------------------------------------------------------------------
CREATE TABLE item_serials (
    serial_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_item_id     BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),
    serial_number     VARCHAR(200) NOT NULL,
    batch_id          BIGINT       REFERENCES item_batches(batch_id),
    status            VARCHAR(20)  NOT NULL DEFAULT 'IN_STOCK'
                      CHECK (status IN (
                          'IN_STOCK', 'SOLD', 'TRANSFERRED',
                          'DAMAGED', 'RETURNED', 'EXPIRED'
                      )),
    godown_id         BIGINT       NOT NULL REFERENCES godowns(godown_id),
    purchase_txn_id   BIGINT       REFERENCES stock_transactions(stock_txn_id),
    sale_txn_id       BIGINT       REFERENCES stock_transactions(stock_txn_id),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_serial UNIQUE (stock_item_id, serial_number)
);

CREATE INDEX idx_serials_item_status ON item_serials(stock_item_id, status);
CREATE INDEX idx_serials_godown       ON item_serials(godown_id);

-------------------------------------------------------------------------------
-- 7. TRACKING LINK — Bridge between stock_transactions and batches/serials
-------------------------------------------------------------------------------
-- Allows a single stock_transaction to cover multiple batches or serials.
-- If an item is NOT tracked, these tables are never touched.
-------------------------------------------------------------------------------
CREATE TABLE stock_txn_batches (
    stock_txn_id  BIGINT NOT NULL REFERENCES stock_transactions(stock_txn_id)
                  ON DELETE CASCADE,
    batch_id      BIGINT NOT NULL REFERENCES item_batches(batch_id),
    quantity      NUMERIC(18,4) NOT NULL,
    PRIMARY KEY (stock_txn_id, batch_id)
);

CREATE TABLE stock_txn_serials (
    stock_txn_id  BIGINT NOT NULL REFERENCES stock_transactions(stock_txn_id)
                  ON DELETE CASCADE,
    serial_id     BIGINT NOT NULL REFERENCES item_serials(serial_id),
    PRIMARY KEY (stock_txn_id, serial_id)
);

-------------------------------------------------------------------------------
-- 8. VALUATION — Stock layers (FIFO) + Weighted Average
-------------------------------------------------------------------------------
CREATE TABLE stock_layers (
    layer_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_item_id     BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),
    godown_id         BIGINT       NOT NULL REFERENCES godowns(godown_id),
    batch_id          BIGINT       REFERENCES item_batches(batch_id),

    -- The PURCHASE stock_txn that created this layer
    purchase_txn_id   BIGINT       NOT NULL REFERENCES stock_transactions(stock_txn_id),

    original_quantity NUMERIC(18,4) NOT NULL,
    remaining_quantity NUMERIC(18,4) NOT NULL
                      CHECK (remaining_quantity >= 0),

    rate              NUMERIC(18,2) NOT NULL,
    purchase_date     DATE         NOT NULL,

    is_exhausted      BOOLEAN      NOT NULL DEFAULT FALSE,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- FIFO consumption: find the oldest non-exhausted layer for an item+godown
CREATE INDEX idx_stock_layers_fifo
    ON stock_layers(stock_item_id, godown_id, purchase_date)
    WHERE is_exhausted = FALSE;

CREATE TABLE stock_valuations (
    stock_item_id     BIGINT NOT NULL REFERENCES stock_items(stock_item_id),
    godown_id         BIGINT NOT NULL REFERENCES godowns(godown_id),
    valuation_method  VARCHAR(20) NOT NULL,

    -- Weighted Average specific
    current_wac       NUMERIC(18,2),          -- current weighted average cost
    total_quantity    NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_value       NUMERIC(18,2) NOT NULL DEFAULT 0,

    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (stock_item_id, godown_id)
);
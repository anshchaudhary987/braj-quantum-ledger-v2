-- ============================================================================
-- DYNAMIC PRICE LISTS — Customer-specific, quantity slabs, date ranges
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. PRICE LEVELS — Customer pricing tiers
-------------------------------------------------------------------------------
CREATE TABLE price_levels (
    price_level_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id        BIGINT       NOT NULL,
    level_name        VARCHAR(50)  NOT NULL,            -- 'Retail', 'Wholesale', 'Distributor'
    is_default        BOOLEAN      NOT NULL DEFAULT FALSE,
    description       TEXT,

    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Each company has exactly one default price level
CREATE UNIQUE INDEX idx_one_default_per_company
    ON price_levels(company_id) WHERE is_default = TRUE;

-- Link customers to price levels (add FK to accounts)
-- ALTER TABLE accounts ADD COLUMN price_level_id BIGINT REFERENCES price_levels(price_level_id);

-------------------------------------------------------------------------------
-- 2. PRICE LIST ITEMS — Stock items × Price Levels × Slabs × Dates
-------------------------------------------------------------------------------
CREATE TABLE price_list_items (
    price_list_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL,

    stock_item_id      BIGINT       NOT NULL REFERENCES stock_items(stock_item_id),
    price_level_id     BIGINT       NOT NULL REFERENCES price_levels(price_level_id),
    uom_id             BIGINT       NOT NULL REFERENCES uom(uom_id),

    rate               NUMERIC(18,2) NOT NULL CHECK (rate >= 0),

    -- Quantity slab (NULL = no lower/upper bound)
    min_quantity       NUMERIC(18,4),                  -- inclusive
    max_quantity       NUMERIC(18,4),                  -- inclusive

    -- Date range for seasonal/time-limited pricing
    applicable_from    DATE,                           -- NULL = always effective from today
    applicable_to      DATE,                           -- NULL = no expiry

    -- Discount (alternative to direct rate)
    discount_percent   NUMERIC(5,2),                   -- discount off the base/default price
    is_discount        BOOLEAN      NOT NULL DEFAULT FALSE,  -- TRUE = rate is a discount, not absolute

    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Prevent overlapping price slabs within same item/level/uom/date range
    CONSTRAINT uq_price_slab UNIQUE (company_id, stock_item_id, price_level_id, uom_id, min_quantity, applicable_from)
);

-- Fast lookup: given a stock item + level + date + quantity
CREATE INDEX idx_price_lookup
    ON price_list_items(stock_item_id, price_level_id, applicable_from, applicable_to, min_quantity, max_quantity)
    WHERE is_active = TRUE;

-- Add price_level_id to the accounts table for customer-specific pricing
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS price_level_id BIGINT REFERENCES price_levels(price_level_id);

-------------------------------------------------------------------------------
-- 3. PRICE LOOKUP FUNCTION — Returns the correct rate for a sales line
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_sales_price(
    p_stock_item_id   BIGINT,
    p_customer_account_id BIGINT,
    p_quantity        NUMERIC,
    p_voucher_date    DATE,
    p_company_id      BIGINT
)
RETURNS TABLE (
    rate             NUMERIC(18,2),
    price_level_used VARCHAR(50),
    matched_by       VARCHAR(20)   -- 'SLAB', 'LEVEL_ONLY', 'DEFAULT'
) AS $$
DECLARE
    v_price_level_id BIGINT;
    v_default_level  BIGINT;
    v_result         RECORD;
BEGIN
    -- 1. Get the customer's price level
    SELECT a.price_level_id INTO v_price_level_id
    FROM accounts a
    WHERE a.account_id  = p_customer_account_id
      AND a.company_id  = p_company_id;

    -- 2. Get the company's default price level
    SELECT pl.price_level_id INTO v_default_level
    FROM price_levels pl
    WHERE pl.company_id = p_company_id AND pl.is_default = TRUE;

    -- 3. First try: customer's price level with quantity slab match
    SELECT pli.rate, pli.price_level_id
    INTO v_result
    FROM price_list_items pli
    WHERE pli.stock_item_id   = p_stock_item_id
      AND pli.price_level_id  = v_price_level_id
      AND pli.is_active       = TRUE
      AND (pli.applicable_from IS NULL OR pli.applicable_from <= p_voucher_date)
      AND (pli.applicable_to   IS NULL OR pli.applicable_to   >= p_voucher_date)
      AND (pli.min_quantity    IS NULL OR pli.min_quantity    <= p_quantity)
      AND (pli.max_quantity    IS NULL OR pli.max_quantity    >= p_quantity)
    ORDER BY pli.min_quantity DESC NULLS LAST  -- prefer more specific slab
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT v_result.rate,
            (SELECT level_name FROM price_levels WHERE price_level_id = v_price_level_id),
            'SLAB'::VARCHAR(20);
        RETURN;
    END IF;

    -- 4. Second try: customer's level without quantity slab (any quantity)
    SELECT pli.rate
    INTO v_result
    FROM price_list_items pli
    WHERE pli.stock_item_id   = p_stock_item_id
      AND pli.price_level_id  = v_price_level_id
      AND pli.is_active       = TRUE
      AND (pli.applicable_from IS NULL OR pli.applicable_from <= p_voucher_date)
      AND (pli.applicable_to   IS NULL OR pli.applicable_to   >= p_voucher_date)
      AND pli.min_quantity IS NULL AND pli.max_quantity IS NULL
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT v_result.rate,
            (SELECT level_name FROM price_levels WHERE price_level_id = v_price_level_id),
            'LEVEL_ONLY'::VARCHAR(20);
        RETURN;
    END IF;

    -- 5. Fallback: default price level with slab match
    IF v_default_level IS NOT NULL THEN
        SELECT pli.rate
        INTO v_result
        FROM price_list_items pli
        WHERE pli.stock_item_id   = p_stock_item_id
          AND pli.price_level_id  = v_default_level
          AND pli.is_active       = TRUE
          AND (pli.applicable_from IS NULL OR pli.applicable_from <= p_voucher_date)
          AND (pli.applicable_to   IS NULL OR pli.applicable_to   >= p_voucher_date)
          AND (pli.min_quantity    IS NULL OR pli.min_quantity    <= p_quantity)
          AND (pli.max_quantity    IS NULL OR pli.max_quantity    >= p_quantity)
        ORDER BY pli.min_quantity DESC NULLS LAST
        LIMIT 1;

        IF FOUND THEN
            RETURN QUERY SELECT v_result.rate,
                (SELECT level_name FROM price_levels WHERE price_level_id = v_default_level),
                'DEFAULT'::VARCHAR(20);
            RETURN;
        END IF;
    END IF;

    -- 6. No price found — return 0 (caller should handle)
    RETURN QUERY SELECT 0::NUMERIC(18,2), 'NONE'::VARCHAR(50), 'NONE'::VARCHAR(20);
END;
$$ LANGUAGE plpgsql STABLE;
-- ============================================================================
-- INVENTORY → ACCOUNTING LINKAGE TRIGGERS
-- Ensures Closing Stock accuracy on the Balance Sheet
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. VALIDATE STOCK AVAILABILITY BEFORE OUTWARD ENTRY
--    Prevents negative stock by checking stock_valuations.total_quantity
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_validate_stock_quantity()
RETURNS TRIGGER AS $$
DECLARE
    v_available NUMERIC(18,4);
    v_item_name TEXT;
BEGIN
    -- Only validate OUTWARD movements (excluding OPENING_STOCK)
    IF NEW.quantity_out > 0 AND NEW.transaction_type <> 'OPENING_STOCK' THEN

        SELECT COALESCE(sv.total_quantity, 0)
        INTO v_available
        FROM stock_valuations sv
        WHERE sv.stock_item_id = NEW.item_id
          AND sv.godown_id     = NEW.godown_id;

        SELECT si.item_name INTO v_item_name
        FROM stock_items si
        WHERE si.stock_item_id = NEW.item_id;

        IF (v_available - NEW.quantity_out) < 0 THEN
            RAISE EXCEPTION 'Insufficient stock for "%" in godown %. Available: %, Requested: %',
                v_item_name, NEW.godown_id, v_available, NEW.quantity_out;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_qty_check
    BEFORE INSERT ON stock_transactions
    FOR EACH ROW
    EXECUTE FUNCTION trg_validate_stock_quantity();

-------------------------------------------------------------------------------
-- 2. UPDATE STOCK VALUATION AFTER EACH MOVEMENT
--    Maintains running total_quantity, total_value, and WAC
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_update_stock_valuation()
RETURNS TRIGGER AS $$
DECLARE
    v_is_inward   BOOLEAN;
    v_qty         NUMERIC(18,4);
    v_val         NUMERIC(18,2);
    v_method      VARCHAR(20);
    v_new_wac     NUMERIC(18,2);
BEGIN
    v_is_inward := NEW.quantity_in > 0;
    v_qty       := NEW.quantity_in - NEW.quantity_out;  -- one is always 0
    v_val       := NEW.amount;

    SELECT valuation_method INTO v_method
    FROM stock_items WHERE stock_item_id = NEW.item_id;

    -- UPSERT into stock_valuations
    INSERT INTO stock_valuations (stock_item_id, godown_id, valuation_method, total_quantity, total_value, current_wac)
    VALUES (NEW.item_id, NEW.godown_id, v_method,
            GREATEST(v_qty, 0),
            CASE WHEN v_is_inward THEN v_val ELSE -v_val END,
            0)
    ON CONFLICT (stock_item_id, godown_id) DO UPDATE
    SET total_quantity = stock_valuations.total_quantity + v_qty,
        total_value    = stock_valuations.total_value
                       + CASE WHEN v_is_inward THEN v_val ELSE -v_val END,
        current_wac    = CASE
            WHEN v_method = 'WEIGHTED_AVERAGE' AND (stock_valuations.total_quantity + v_qty) > 0 THEN
                (stock_valuations.total_value + CASE WHEN v_is_inward THEN v_val ELSE -v_val END)
                / (stock_valuations.total_quantity + v_qty)
            ELSE stock_valuations.current_wac
        END,
        updated_at     = now();

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_valuation_update
    AFTER INSERT ON stock_transactions
    FOR EACH ROW
    EXECUTE FUNCTION trg_update_stock_valuation();

-------------------------------------------------------------------------------
-- 3. MANAGE FIFO LAYERS
--    On PURCHASE → create layer. On SALES → consume from oldest layer.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_manage_stock_layers()
RETURNS TRIGGER AS $$
DECLARE
    rec RECORD;
    v_remaining NUMERIC(18,4);
    v_layer_qty NUMERIC(18,4);
    v_cogs      NUMERIC(18,2) := 0;
BEGIN
    IF NEW.quantity_in > 0
       AND NEW.transaction_type IN ('PURCHASE', 'PURCHASE_RETURN', 'PRODUCTION_IN', 'OPENING_STOCK')
    THEN
        -- Create a new stock layer
        INSERT INTO stock_layers
            (stock_item_id, godown_id, purchase_txn_id, original_quantity, remaining_quantity, rate, purchase_date)
        VALUES
            (NEW.item_id, NEW.godown_id, NEW.stock_txn_id,
             NEW.quantity_in, NEW.quantity_in, NEW.rate, NEW.created_at::DATE);

    ELSIF NEW.quantity_out > 0
          AND NEW.transaction_type IN ('SALES', 'SALES_RETURN', 'TRANSFER_OUT', 'PRODUCTION_OUT')
    THEN
        -- Consume from oldest non-exhausted layers (FIFO)
        v_remaining := NEW.quantity_out;

        FOR rec IN
            SELECT layer_id, remaining_quantity, rate
            FROM stock_layers
            WHERE stock_item_id = NEW.item_id
              AND godown_id     = NEW.godown_id
              AND is_exhausted  = FALSE
            ORDER BY purchase_date ASC, layer_id ASC
            FOR UPDATE          -- row-level lock prevents race conditions
        LOOP
            IF v_remaining <= 0 THEN EXIT; END IF;

            v_layer_qty := LEAST(v_remaining, rec.remaining_quantity);

            UPDATE stock_layers
            SET remaining_quantity = remaining_quantity - v_layer_qty,
                is_exhausted = (remaining_quantity - v_layer_qty) <= 0
            WHERE layer_id = rec.layer_id;

            v_cogs      := v_cogs + (v_layer_qty * rec.rate);
            v_remaining := v_remaining - v_layer_qty;
        END LOOP;

        IF v_remaining > 0 THEN
            RAISE EXCEPTION 'FIFO layer underflow: cannot consume % units for item % in godown %',
                v_remaining, NEW.item_id, NEW.godown_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_layers_maintain
    AFTER INSERT ON stock_transactions
    FOR EACH ROW
    EXECUTE FUNCTION trg_manage_stock_layers();

-------------------------------------------------------------------------------
-- 4. UPDATE SERIAL NUMBER STATUS ON SALE / TRANSFER
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_update_serial_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.quantity_out > 0
       AND NEW.transaction_type IN ('SALES', 'TRANSFER_OUT') THEN

        UPDATE item_serials s
        SET status      = CASE WHEN NEW.transaction_type = 'SALES' THEN 'SOLD' ELSE 'TRANSFERRED' END,
            sale_txn_id = NEW.stock_txn_id,
            updated_at  = now()
        FROM stock_txn_serials sts
        WHERE sts.stock_txn_id = NEW.stock_txn_id
          AND sts.serial_id    = s.serial_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_serial_status_update
    AFTER INSERT ON stock_transactions
    FOR EACH ROW
    WHEN (NEW.quantity_out > 0)
    EXECUTE FUNCTION trg_update_serial_status();
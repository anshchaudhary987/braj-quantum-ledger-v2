import { PoolClient } from "pg";
import {
  UomConversionResult,
  CreateStockMovementInput,
  StockMovementResult,
  UomRow,
  StockItemRow,
  StockTransactionRow,
} from "./inventory-types.js";

// ---------------------------------------------------------------------------
// INVENTORY SERVICE — UOM conversion + stock movement operations
// ---------------------------------------------------------------------------

export class InventoryService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // UOM CONVERSION
  // -----------------------------------------------------------------------

  /**
   * Convert a user-supplied quantity in any UOM into the item's base UOM.
   *
   * Math:
   *   base_qty = input_qty × conversion_factor_of(input_uom)
   *
   * Example:
   *   Input:  2 Boxes (conversion_factor = 100) → 200 Pieces (base)
   *   Input:  20 Packs (conversion_factor = 10)  → 200 Pieces
   */
  async convertToBase(
    itemId: number,
    quantity: number,
    fromUomId: number
  ): Promise<UomConversionResult> {
    const { rows: itemRows } = await this.client.query<StockItemRow>(
      `SELECT base_uom_id FROM stock_items WHERE stock_item_id = $1`,
      [itemId]
    );
    const baseUomId = itemRows[0]?.base_uom_id;
    if (!baseUomId) throw new Error(`Item ${itemId} not found`);

    // If user already supplied base UOM, no conversion needed
    if (fromUomId === baseUomId) {
      const { rows: uomRows } = await this.client.query<UomRow>(
        `SELECT symbol FROM uom WHERE uom_id = $1`,
        [baseUomId]
      );
      return {
        base_quantity: quantity,
        base_uom_id: baseUomId,
        base_symbol: uomRows[0]?.symbol ?? "",
        from_symbol: uomRows[0]?.symbol ?? "",
      };
    }

    // Fetch the conversion factor of the input UOM
    const { rows: uomRows } = await this.client.query<UomRow & { base_symbol: string }>(
      `SELECT u.uom_id, u.symbol, u.conversion_factor,
              bu.symbol AS base_symbol
       FROM uom u
       JOIN uom bu ON bu.uom_id = $2
       WHERE u.uom_id = $1`,
      [fromUomId, baseUomId]
    );

    const factor = uomRows[0] ? Number(uomRows[0].conversion_factor) : 1;

    return {
      base_quantity: quantity * factor,
      base_uom_id: baseUomId,
      base_symbol: uomRows[0]?.base_symbol ?? "",
      from_symbol: uomRows[0]?.symbol ?? "",
    };
  }

  /**
   * Reverse: display a base-UOM quantity in a display UOM.
   *   200 Pieces → 2 Boxes
   */
  async convertFromBase(
    baseQuantity: number,
    toUomId: number
  ): Promise<{ display_quantity: number; symbol: string }> {
    const { rows } = await this.client.query<UomRow>(
      `SELECT symbol, conversion_factor FROM uom WHERE uom_id = $1`,
      [toUomId]
    );

    const factor = rows[0] ? Number(rows[0].conversion_factor) : 1;
    return {
      display_quantity: baseQuantity / factor,
      symbol: rows[0]?.symbol ?? "",
    };
  }

  // -----------------------------------------------------------------------
  // STOCK MOVEMENT — orchestrated insert
  // -----------------------------------------------------------------------

  /**
   * Records a stock movement (IN or OUT) and updates all dependent tables
   * via database triggers. The accounting transaction must already exist
   * before calling this method — pass its transaction_id.
   */
  async recordMovement(
    input: CreateStockMovementInput,
    accountingTransactionId: number,
    accountingJournalEntryId?: number
  ): Promise<StockMovementResult> {
    // 1. Convert user quantity → base UOM
    const conversion = await this.convertToBase(input.item_id, input.quantity, input.uom_id);

    // 2. Determine direction
    const isInward = [
      "PURCHASE",
      "PURCHASE_RETURN", // treating return as inward back to stock
      "TRANSFER_IN",
      "ADJUSTMENT_IN",
      "PRODUCTION_IN",
      "OPENING_STOCK",
    ].includes(input.transaction_type);

    const quantityIn  = isInward ? conversion.base_quantity : 0;
    const quantityOut = isInward ? 0 : conversion.base_quantity;

    // 3. Fetch item details for valuation method
    const { rows: itemRows } = await this.client.query<StockItemRow>(
      `SELECT valuation_method FROM stock_items WHERE stock_item_id = $1`,
      [input.item_id]
    );
    const valuationMethod = itemRows[0]?.valuation_method ?? "WEIGHTED_AVERAGE";

    // 4. Read current valuation (for result reporting)
    const { rows: valBefore } = await this.client.query<{
      current_wac: string | null;
      total_quantity: string;
      total_value: string;
    }>(
      `SELECT current_wac, total_quantity, total_value
       FROM stock_valuations
       WHERE stock_item_id = $1 AND godown_id = $2`,
      [input.item_id, input.godown_id]
    );

    const wacBefore = valBefore[0]?.current_wac ? Number(valBefore[0].current_wac) : null;

    // 5. Insert the stock_transaction row (triggers handle valuation + layers)
    const { rows: txnRows } = await this.client.query<StockTransactionRow>(
      `INSERT INTO stock_transactions
          (transaction_id, journal_entry_id, transaction_type,
           item_id, godown_id,
           quantity_in, quantity_out, rate, amount,
           uom_id, uom_quantity,
           reference_type, reference_id, narration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        accountingTransactionId,
        accountingJournalEntryId ?? null,
        input.transaction_type,
        input.item_id,
        input.godown_id,
        quantityIn,
        quantityOut,
        input.rate,
        input.amount,
        input.uom_id,
        input.quantity,
        input.reference_type ?? null,
        input.reference_id ?? null,
        input.narration ?? null,
      ]
    );

    const stockTxn = txnRows[0];

    // 6. Link batch allocations (if any)
    if (input.batch_allocations && input.batch_allocations.length > 0) {
      for (const b of input.batch_allocations) {
        await this.client.query(
          `INSERT INTO stock_txn_batches (stock_txn_id, batch_id, quantity)
           VALUES ($1, $2, $3)`,
          [stockTxn.stock_txn_id, b.batch_id, b.quantity]
        );
      }
    }

    // 7. Link serial numbers (if any)
    if (input.serial_numbers && input.serial_numbers.length > 0) {
      for (const s of input.serial_numbers) {
        await this.client.query(
          `INSERT INTO stock_txn_serials (stock_txn_id, serial_id) VALUES ($1, $2)`,
          [stockTxn.stock_txn_id, s]
        );
      }
    }

    // 8. Read post-update valuation
    const { rows: valAfter } = await this.client.query<{
      current_wac: string | null;
    }>(
      `SELECT current_wac FROM stock_valuations
       WHERE stock_item_id = $1 AND godown_id = $2`,
      [input.item_id, input.godown_id]
    );

    const wacAfter = valAfter[0]?.current_wac ? Number(valAfter[0].current_wac) : null;

    // 9. Count layers consumed (for FIFO items on outward movement)
    let layersConsumed = 0;
    if (quantityOut > 0) {
      const { rows: layerRows } = await this.client.query<{ cnt: string }>(
        `SELECT COUNT(*)::TEXT AS cnt FROM stock_layers
         WHERE stock_item_id = $1 AND godown_id = $2
           AND is_exhausted = TRUE
           AND purchase_txn_id <= $3`,
        [input.item_id, input.godown_id, stockTxn.stock_txn_id]
      );
      layersConsumed = Number(layerRows[0]?.cnt ?? 0);
    }

    return {
      stock_txn_id: stockTxn.stock_txn_id,
      transaction_id: Number(stockTxn.transaction_id),
      quantity_in_base: conversion.base_quantity,
      valuation_impact: {
        method: valuationMethod,
        wac_before: wacBefore,
        wac_after: wacAfter,
        layers_consumed: layersConsumed,
        cogs: quantityOut > 0 ? quantityOut * (wacBefore ?? input.rate) : 0,
      },
    };
  }

  // -----------------------------------------------------------------------
  // STOCK LEDGER QUERY — returns all movements for an item+godown
  // -----------------------------------------------------------------------
  async getStockLedger(
    itemId: number,
    godownId: number,
    fromDate: string,
    toDate: string
  ): Promise<{
    item_name: string;
    godown_name: string;
    opening_quantity: number;
    opening_value: number;
    movements: Array<{
      stock_txn_id: number;
      date: string;
      transaction_type: string;
      quantity_in: number;
      quantity_out: number;
      running_quantity: number;
      rate: number;
      amount: number;
      narration: string | null;
    }>;
    closing_quantity: number;
    closing_value: number;
  }> {
    // Opening balance before fromDate
    const { rows: opening } = await this.client.query<{
      qty: string;
      val: string;
    }>(
      `SELECT COALESCE(SUM(quantity_in  - quantity_out), 0) AS qty,
              COALESCE(SUM(CASE WHEN quantity_in > 0 THEN amount ELSE -amount END), 0) AS val
       FROM stock_transactions
       WHERE item_id = $1 AND godown_id = $2 AND created_at < $3::timestamptz`,
      [itemId, godownId, `${fromDate}T00:00:00Z`]
    );

    let runningQty  = Number(opening[0].qty);
    let runningVal  = Number(opening[0].val);

    const { rows: movements } = await this.client.query<{
      stock_txn_id: number;
      created_at: string;
      transaction_type: string;
      quantity_in: string;
      quantity_out: string;
      rate: string;
      amount: string;
      narration: string | null;
    }>(
      `SELECT stock_txn_id, created_at::TEXT, transaction_type,
              quantity_in, quantity_out, rate, amount, narration
       FROM stock_transactions
       WHERE item_id = $1 AND godown_id = $2
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz
       ORDER BY created_at, stock_txn_id`,
      [itemId, godownId, `${fromDate}T00:00:00Z`, `${toDate}T23:59:59Z`]
    );

    const enriched = movements.map((m) => {
      const qtyIn  = Number(m.quantity_in);
      const qtyOut = Number(m.quantity_out);
      runningQty += qtyIn - qtyOut;
      runningVal += qtyIn > 0 ? Number(m.amount) : -Number(m.amount);

      return {
        stock_txn_id: m.stock_txn_id,
        date: m.created_at,
        transaction_type: m.transaction_type,
        quantity_in: qtyIn,
        quantity_out: qtyOut,
        running_quantity: runningQty,
        rate: Number(m.rate),
        amount: Number(m.amount),
        narration: m.narration,
      };
    });

    const { rows: names } = await this.client.query<{
      item_name: string;
      godown_name: string;
    }>(
      `SELECT si.item_name, g.godown_name
       FROM stock_items si, godowns g
       WHERE si.stock_item_id = $1 AND g.godown_id = $2`,
      [itemId, godownId]
    );

    return {
      item_name: names[0]?.item_name ?? "",
      godown_name: names[0]?.godown_name ?? "",
      opening_quantity: Number(opening[0].qty),
      opening_value: Number(opening[0].val),
      movements: enriched,
      closing_quantity: runningQty,
      closing_value: runningVal,
    };
  }

  // -----------------------------------------------------------------------
  // CURRENT STOCK — quantity on hand per godown
  // -----------------------------------------------------------------------
  async getCurrentStock(
    itemId: number,
    godownId: number
  ): Promise<{
    quantity: number;
    value: number;
    wac: number | null;
    method: string;
  }> {
    const { rows } = await this.client.query<StockItemRow & {
      total_quantity: string;
      total_value: string;
      current_wac: string | null;
    }>(
      `SELECT si.valuation_method,
              sv.total_quantity, sv.total_value, sv.current_wac
       FROM stock_items si
       LEFT JOIN stock_valuations sv
         ON sv.stock_item_id = si.stock_item_id
        AND sv.godown_id = $2
       WHERE si.stock_item_id = $1`,
      [itemId, godownId]
    );

    const r = rows[0];
    return {
      quantity: r ? Number(r.total_quantity) : 0,
      value:    r ? Number(r.total_value)    : 0,
      wac:      r?.current_wac ? Number(r.current_wac) : null,
      method:   r?.valuation_method ?? "WEIGHTED_AVERAGE",
    };
  }
}

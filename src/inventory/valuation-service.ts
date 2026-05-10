import { PoolClient } from "pg";
import { StockLayerRow, FifoConsumption } from "./inventory-types";

// ---------------------------------------------------------------------------
// VALUATION SERVICE — FIFO & Weighted Average Cost
// ---------------------------------------------------------------------------
//
// Valuation Method Comparison:
//
//   FIFO (First In, First Out):
//     - Tracks each purchase as a separate "layer" with qty + rate.
//     - On sale, consumes from the OLDEST layer first.
//     - COGS = sum(layer.rate × qty_consumed) for all consumed layers.
//     - Closing stock = remaining layers × their respective rates.
//     - More accurate when prices fluctuate. Requires more storage.
//
//   WEIGHTED AVERAGE:
//     - Maintains a single running average: WAC = total_value / total_quantity.
//     - Recalculated after every purchase.
//     - COGS = quantity_sold × current WAC (at time of sale).
//     - Simpler, less storage, but slightly less precise during price swings.
//
//   This service provides read-access and analysis. The actual layer
//   management is done by database triggers (stock_accounting_triggers.sql).
// ---------------------------------------------------------------------------

export class ValuationService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Returns the current valuation snapshot for an item+godown.
   */
  async getValuation(
    itemId: number,
    godownId: number
  ): Promise<{
    method: string;
    total_quantity: number;
    total_value: number;
    wac: number | null;
    layer_count: number;
  }> {
    const { rows } = await this.client.query<{
      method: string;
      total_quantity: string;
      total_value: string;
      wac: string | null;
    }>(
      `SELECT sv.valuation_method         AS method,
              sv.total_quantity,
              sv.total_value,
              sv.current_wac               AS wac
       FROM stock_valuations sv
       WHERE sv.stock_item_id = $1 AND sv.godown_id = $2`,
      [itemId, godownId]
    );

    if (rows.length === 0) {
      return { method: "WEIGHTED_AVERAGE", total_quantity: 0, total_value: 0, wac: null, layer_count: 0 };
    }

    // Count non-exhausted layers (FIFO)
    const { rows: layerCount } = await this.client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM stock_layers
       WHERE stock_item_id = $1 AND godown_id = $2 AND is_exhausted = FALSE`,
      [itemId, godownId]
    );

    return {
      method: rows[0].method,
      total_quantity: Number(rows[0].total_quantity),
      total_value:    Number(rows[0].total_value),
      wac:            rows[0].wac ? Number(rows[0].wac) : null,
      layer_count:    Number(layerCount[0]?.cnt ?? 0),
    };
  }

  /**
   * Simulate what the FIFO COGS would be for a given sale quantity.
   * Does NOT modify the database — useful for "what-if" or invoice preview.
   */
  async simulateFifoConsumption(
    itemId: number,
    godownId: number,
    saleQuantity: number
  ): Promise<{
    layers: FifoConsumption[];
    total_cogs: number;
    remaining_quantity: number;
    is_sufficient: boolean;
  }> {
    const { rows: layers } = await this.client.query<StockLayerRow>(
      `SELECT layer_id, remaining_quantity, rate
       FROM stock_layers
       WHERE stock_item_id = $1
         AND godown_id     = $2
         AND is_exhausted  = FALSE
       ORDER BY purchase_date ASC, layer_id ASC`,
      [itemId, godownId]
    );

    const consumption: FifoConsumption[] = [];
    let remaining = saleQuantity;
    let totalCogs = 0;

    for (const layer of layers) {
      if (remaining <= 0) break;
      const available = Number(layer.remaining_quantity);
      const consumed  = Math.min(remaining, available);

      consumption.push({
        layer_id:          layer.layer_id,
        quantity_consumed: consumed,
        rate:              Number(layer.rate),
        cost:              consumed * Number(layer.rate),
      });

      totalCogs += consumed * Number(layer.rate);
      remaining -= consumed;
    }

    return {
      layers: consumption,
      total_cogs: totalCogs,
      remaining_quantity: remaining,
      is_sufficient: remaining <= 0,
    };
  }

  /**
   * Returns the detailed FIFO layer breakdown (non-exhausted).
   * Useful for audit reports or stock-ageing analysis.
   */
  async getFifoBreakdown(
    itemId: number,
    godownId: number
  ): Promise<
    Array<{
      layer_id: number;
      batch_id: number | null;
      batch_number: string | null;
      remaining_quantity: number;
      rate: number;
      value: number;
      purchase_date: string;
      age_days: number;
    }>
  > {
    const { rows } = await this.client.query<{
      layer_id: number;
      batch_id: number | null;
      batch_number: string | null;
      remaining_quantity: string;
      rate: string;
      purchase_date: string;
    }>(
      `SELECT sl.layer_id, sl.batch_id, ib.batch_number,
              sl.remaining_quantity, sl.rate,
              sl.purchase_date::TEXT AS purchase_date
       FROM stock_layers sl
       LEFT JOIN item_batches ib ON ib.batch_id = sl.batch_id
       WHERE sl.stock_item_id = $1
         AND sl.godown_id     = $2
         AND sl.is_exhausted  = FALSE
       ORDER BY sl.purchase_date`,
      [itemId, godownId]
    );

    const now = new Date();

    return rows.map((r) => {
      const qty = Number(r.remaining_quantity);
      const rate = Number(r.rate);
      const purchaseDate = new Date(r.purchase_date);
      const ageDays = Math.floor(
        (now.getTime() - purchaseDate.getTime()) / 86_400_000
      );

      return {
        layer_id: r.layer_id,
        batch_id: r.batch_id,
        batch_number: r.batch_number,
        remaining_quantity: qty,
        rate,
        value: qty * rate,
        purchase_date: r.purchase_date,
        age_days: ageDays,
      };
    });
  }
}
import { PoolClient } from "pg";
import {
  ProcessManufacturingInput,
  MfgProcessResult,
  BomRow,
  BomItemRow,
  MfgJournalRow,
} from "./manufacturing-types.js";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// MANUFACTURING SERVICE — Process a Manufacturing Journal
// ---------------------------------------------------------------------------

export class ManufacturingService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Process a Manufacturing Journal — the core logic.
   *
   * Steps:
   *   1. Load BOM and its items
   *   2. Calculate quantities for each component scaled to quantity_produced
   *   3. Value raw materials at current WAC (weighted average cost)
   *   4. Value by-products at their standard credit rate
   *   5. Apply overhead costs
   *   6. Compute finished good unit cost:
   *        unit_cost = (total_raw_material + total_overhead - by_product_value)
   *                    / quantity_produced
   *   7. Create accounting transaction:
   *        Debit  Finished Good Stock  (total_fg_cost)
   *        Credit Raw Material Stock A  (consumed value)
   *        Credit Raw Material Stock B  (consumed value)
   *        Credit By-Product Stock      (by-product value)
   *   8. Create stock_transactions for each component (IN/OUT)
   *   9. Record the manufacturing journal for audit
   */
  async processManufacturing(
    input: ProcessManufacturingInput,
    companyId: number
  ): Promise<MfgProcessResult> {
    // ---- STEP 1: Load BOM ----
    const { rows: bomRows } = await this.client.query<BomRow>(
      `SELECT * FROM boms WHERE bom_id = $1 AND company_id = $2 AND is_active = TRUE`,
      [input.bom_id, companyId]
    );

    const bom = bomRows[0];
    if (!bom) throw new AppError(ErrorCode.NOT_FOUND, "BOM not found or inactive.");

    const { rows: itemRows } = await this.client.query<BomItemRow>(
      `SELECT * FROM bom_items WHERE bom_id = $1 ORDER BY sort_order`,
      [input.bom_id]
    );

    const baseOutput = Number(bom.base_output_quantity);
    const qtyProduced = input.quantity_produced;
    const scaleFactor = qtyProduced / baseOutput;

    // ---- STEP 2: Compute per-component quantities and costs ----
    let totalRawMaterialCost = 0;
    let totalByProductValue  = 0;

    const rawMaterialLines: Array<{
      stock_item_id: number; quantity: number; uom_id: number; rate: number; amount: number;
    }> = [];
    const byProductLines: Array<{
      stock_item_id: number; quantity: number; uom_id: number; credit_rate: number; amount: number;
    }> = [];

    for (const item of itemRows) {
      const requiredQty  = Number(item.required_quantity);
      const scrapPct     = Number(item.scrap_percentage);
      const scaledQty    = requiredQty * scaleFactor * (1 + scrapPct / 100);

      if (item.item_type === "RAW_MATERIAL") {
        // Get the current WAC for this raw material
        const { rows: valRows } = await this.client.query<{ current_wac: string }>(
          `SELECT current_wac FROM stock_valuations
           WHERE stock_item_id = $1 AND godown_id = $2`,
          [item.stock_item_id, input.godown_id]
        );

        const rate = valRows[0]?.current_wac ? Number(valRows[0].current_wac) : 0;
        const amount = scaledQty * rate;

        rawMaterialLines.push({
          stock_item_id: item.stock_item_id,
          quantity: scaledQty, uom_id: item.uom_id, rate, amount,
        });
        totalRawMaterialCost += amount;
      } else if (item.item_type === "BY_PRODUCT" || item.item_type === "CO_PRODUCT") {
        // By-products: use last sales rate or standard valuation rate as credit
        const creditRate = await this.getByProductCreditRate(item.stock_item_id);
        const amount = scaledQty * creditRate;

        byProductLines.push({
          stock_item_id: item.stock_item_id,
          quantity: scaledQty, uom_id: item.uom_id, credit_rate: creditRate, amount,
        });
        totalByProductValue += amount;
      }
    }

    // ---- STEP 3: Apply overhead costs ----
    let totalOverheadCost = 0;

    for (const oh of input.overhead_costs) {
      let allocatedAmount = oh.cost_amount;

      if (oh.allocation_method === "PER_UNIT") {
        allocatedAmount = oh.cost_amount; // already a fixed amount
      } else if (oh.allocation_method === "PERCENTAGE_OF_MATERIAL") {
        allocatedAmount = totalRawMaterialCost * (oh.allocation_percentage ?? 0) / 100;
      }
      // FIXED_TOTAL: amount as-is

      totalOverheadCost += allocatedAmount;
    }

    // ---- STEP 4: Compute finished good valuation ----
    const totalFgCost = totalRawMaterialCost + totalOverheadCost - totalByProductValue;
    const unitCost    = totalFgCost / qtyProduced;

    // ---- STEP 5: Create accounting transaction ----
    const { rows: txnRows } = await this.client.query<{ transaction_id: number }>(
      `INSERT INTO transactions (tenant_id, txn_date, description, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING transaction_id`,
      [String(companyId), input.production_date,
       `Manufacturing Journal — FG: ${bom.finished_good_item_id} — Qty: ${qtyProduced} — BOM: ${bom.bom_name}`,
       JSON.stringify({ bom_id: bom.bom_id, quantity_produced: qtyProduced })]
    );

    const txnId = txnRows[0].transaction_id;

    // ---- STEP 5a: Insert journal entries ----
    // Debit: Finished Good Stock (total FG cost)
    await this.client.query(
      `INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
       VALUES ($1, $2, $3, 0, $4)`,
      [txnId, bom.finished_good_item_id, totalFgCost,
       `Manufactured ${qtyProduced} units of FG #${bom.finished_good_item_id}`]
    );

    // Credit: Each raw material consumed
    for (const rm of rawMaterialLines) {
      await this.client.query(
        `INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
         VALUES ($1, $2, 0, $3, $4)`,
        [txnId, rm.stock_item_id, rm.amount,
         `RM consumed: ${rm.quantity} units @ ₹${rm.rate.toFixed(2)}`]
      );
    }

    // Credit: By-products (reduces FG cost)
    for (const bp of byProductLines) {
      await this.client.query(
        `INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
         VALUES ($1, $2, 0, $3, $4)`,
        [txnId, bp.stock_item_id, bp.amount,
         `By-product produced: ${bp.quantity} units @ ₹${bp.credit_rate.toFixed(2)}`]
      );
    }

    // ---- STEP 6: Create stock_transactions (record the physical movement) ----
    const stockMovements: MfgProcessResult["stock_movements"] = [];

    // OUT: Raw materials consumed
    for (const rm of rawMaterialLines) {
      const { rows: stkRows } = await this.client.query<{ stock_txn_id: number }>(
        `INSERT INTO stock_transactions
           (transaction_id, transaction_type, item_id, godown_id,
            quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
         VALUES ($1, 'PRODUCTION_OUT', $2, $3, 0, $4, $5, $6, $7, $4, $8)
         RETURNING stock_txn_id`,
        [txnId, rm.stock_item_id, input.godown_id, rm.quantity, rm.rate, rm.amount,
         rm.uom_id, 'Raw material consumed in manufacturing']
      );
      stockMovements.push({
        stock_txn_id: stkRows[0].stock_txn_id,
        item_id: rm.stock_item_id, item_name: `RM #${rm.stock_item_id}`,
        item_type: "RAW_MATERIAL", quantity: rm.quantity, direction: "OUT",
      });
    }

    // IN: Finished Good produced
    const { rows: fgStkRows } = await this.client.query<{ stock_txn_id: number }>(
      `INSERT INTO stock_transactions
         (transaction_id, transaction_type, item_id, godown_id,
          quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
       VALUES ($1, 'PRODUCTION_IN', $2, $3, $4, 0, $5, $6, $7, $4, $8)
       RETURNING stock_txn_id`,
      [txnId, bom.finished_good_item_id, input.godown_id, qtyProduced,
       unitCost, totalFgCost, 0, 'Finished good manufactured']
    );
    stockMovements.push({
      stock_txn_id: fgStkRows[0].stock_txn_id,
      item_id: bom.finished_good_item_id, item_name: `FG #${bom.finished_good_item_id}`,
      item_type: "FINISHED_GOOD", quantity: qtyProduced, direction: "IN",
    });

    // IN: By-products
    for (const bp of byProductLines) {
      const { rows: bpStkRows } = await this.client.query<{ stock_txn_id: number }>(
        `INSERT INTO stock_transactions
           (transaction_id, transaction_type, item_id, godown_id,
            quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
         VALUES ($1, 'PRODUCTION_IN', $2, $3, $4, 0, $5, $6, $7, $4, $8)
         RETURNING stock_txn_id`,
        [txnId, bp.stock_item_id, input.godown_id, bp.quantity, bp.credit_rate,
         bp.amount, bp.uom_id, 'By-product from manufacturing']
      );
      stockMovements.push({
        stock_txn_id: bpStkRows[0].stock_txn_id,
        item_id: bp.stock_item_id, item_name: `BP #${bp.stock_item_id}`,
        item_type: "BY_PRODUCT", quantity: bp.quantity, direction: "IN",
      });
    }

    // ---- STEP 7: Record manufacturing journal ----
    const { rows: mfgRows } = await this.client.query<MfgJournalRow>(
      `INSERT INTO manufacturing_journals
         (company_id, transaction_id, bom_id, finished_good_item_id,
          quantity_produced, godown_id, production_date, narration,
          total_raw_material_cost, total_overhead_cost, total_by_product_value,
          total_fg_cost, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING mfg_journal_id`,
      [companyId, txnId, bom.bom_id, bom.finished_good_item_id,
       qtyProduced, input.godown_id, input.production_date, input.narration ?? null,
       totalRawMaterialCost, totalOverheadCost, totalByProductValue,
       totalFgCost, unitCost]
    );

    const mfgJournalId = mfgRows[0].mfg_journal_id;

    // ---- STEP 8: Record overhead detail ----
    for (const oh of input.overhead_costs) {
      await this.client.query(
        `INSERT INTO manufacturing_overhead
           (mfg_journal_id, cost_type, cost_description, cost_amount,
            allocation_method, allocation_percentage)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [mfgJournalId, oh.cost_type, oh.cost_description ?? null,
         oh.cost_amount, oh.allocation_method, oh.allocation_percentage ?? null]
      );
    }

    return {
      transaction_id: txnId,
      mfg_journal_id: mfgJournalId,
      cost_summary: {
        raw_material_cost: totalRawMaterialCost,
        overhead_cost: totalOverheadCost,
        by_product_value: totalByProductValue,
        total_fg_cost: totalFgCost,
        unit_cost: unitCost,
      },
      stock_movements: stockMovements,
    };
  }

  private async getByProductCreditRate(stockItemId: number): Promise<number> {
    const { rows } = await this.client.query<{ rate: string }>(
      `SELECT COALESCE(current_wac, 0)::TEXT AS rate
       FROM stock_valuations WHERE stock_item_id = $1
       LIMIT 1`,
      [stockItemId]
    );
    return rows[0] ? Number(rows[0].rate) : 0;
  }
}

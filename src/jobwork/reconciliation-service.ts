import { PoolClient } from "pg";
import {
  JobWorkYieldRow,
  VendorStockRow,
  JobWorkValuationResult,
} from "./jobwork-types";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// RECONCILIATION SERVICE — Yield, scrap, FG valuation
// ---------------------------------------------------------------------------

export class JobWorkReconciliationService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // YIELD REPORT — What was sent vs received for a JOB_WORK_IN
  // -----------------------------------------------------------------------

  /**
   * Example output:
   *   Sent:  100 kg Steel → Received: 90 kg Parts (90% yield)
   *                             Scrap:    10 kg (10% scrap)
   *
   *   Sent:   50 kg Aluminium → Received: 48 kg Parts (96% yield)
   *                               Scrap:    2 kg (4%)
   */
  async getYield(challanId: number): Promise<JobWorkYieldRow[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM get_job_work_yield($1)`,
      [challanId]
    );

    return rows.map((r: any) => ({
      stock_item_id: Number(r.stock_item_id),
      item_name: r.item_name,
      item_type: r.item_type,
      quantity_sent: Number(r.quantity_sent),
      quantity_received: Number(r.quantity_received),
      quantity_pending: Number(r.quantity_pending),
      scrap_generated: Number(r.scrap_generated),
      yield_pct: Number(r.yield_pct),
    }));
  }

  // -----------------------------------------------------------------------
  // VENDOR STOCK — What's lying with each vendor right now
  // -----------------------------------------------------------------------

  async getVendorStock(companyId: number): Promise<VendorStockRow[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM vw_job_work_stock_with_vendor WHERE true ORDER BY vendor_name`,
    );
    return rows.map((r: any) => ({
      godown_id: Number(r.godown_id),
      godown_name: r.godown_name,
      vendor_name: r.vendor_name,
      stock_item_id: Number(r.stock_item_id),
      item_name: r.item_name,
      quantity_with_vendor: Number(r.quantity_with_vendor),
      value_with_vendor: Number(r.value_with_vendor),
      current_wac: r.current_wac ? Number(r.current_wac) : null,
    }));
  }

  async getVendorStockDetail(
    vendorAccountId: number
  ): Promise<{
    vendor_name: string;
    godown_id: number;
    items: VendorStockRow[];
  }> {
    const { rows } = await this.client.query(
      `SELECT * FROM vw_job_work_stock_with_vendor
       WHERE party_account_id = $1
       ORDER BY item_name`,
      [vendorAccountId]
    );

    const items = rows.map((r: any) => ({
      godown_id: Number(r.godown_id),
      godown_name: r.godown_name,
      vendor_name: r.vendor_name,
      stock_item_id: Number(r.stock_item_id),
      item_name: r.item_name,
      quantity_with_vendor: Number(r.quantity_with_vendor),
      value_with_vendor: Number(r.value_with_vendor),
      current_wac: r.current_wac ? Number(r.current_wac) : null,
    }));

    return {
      vendor_name: items[0]?.vendor_name ?? "Unknown",
      godown_id: items[0]?.godown_id ?? 0,
      items,
    };
  }

  // -----------------------------------------------------------------------
  // FG VALUATION — Compute final cost of job work produced goods
  // -----------------------------------------------------------------------

  /**
   * Valuates the finished goods received from a JOB_WORK_IN challan.
   *
   * Formula:
   *   RM Cost     = Σ (consumed_qty × WAC of each raw material)
   *   Service      = vendor's labour charges from the linked service invoice
   *   Scrap Value  = Σ (scrap_qty × scrap_rate)
   *   FG Total Cost = RM Cost + Service Charges - Scrap Value
   *   FG Unit Cost  = FG Total Cost / total finished good quantity
   *
   * This should be called AFTER the service invoice is linked.
   */
  async computeValuation(
    challanId: number,
    companyId: number
  ): Promise<JobWorkValuationResult> {
    // 1. Load challan with linked service invoice
    const { rows: challanRows } = await this.client.query<{
      challan_id: number;
      reference_challan_id: number;
      is_accounted: boolean;
      service_transaction_id: number | null;
    }>(
      `SELECT challan_id, reference_challan_id, is_accounted, service_transaction_id
       FROM delivery_challans
       WHERE challan_id = $1 AND challan_type = 'JOB_WORK_IN' AND company_id = $2`,
      [challanId, companyId]
    );

    const challan = challanRows[0];
    if (!challan) throw new AppError(ErrorCode.NOT_FOUND, "JOB_WORK_IN challan not found.");

    // 2. Sum raw material cost (consumed from vendor godown)
    const { rows: rmRows } = await this.client.query<{ total_cost: string }>(
      `SELECT COALESCE(SUM(dci.quantity * sv.current_wac), 0)::TEXT AS total_cost
       FROM delivery_challan_items dci
       JOIN stock_valuations sv
         ON sv.stock_item_id = dci.stock_item_id
        AND sv.godown_id = (SELECT vendor_godown_id FROM delivery_challans WHERE challan_id = $1)
       WHERE dci.challan_id = $1 AND dci.item_type = 'RAW_MATERIAL'`,
      [challanId]
    );

    const rawMaterialCost = Number(rmRows[0]?.total_cost ?? 0);

    // 3. Get service charges from the linked invoice
    let serviceCharges = 0;

    if (challan.is_accounted && challan.service_transaction_id) {
      const { rows: svcRows } = await this.client.query<{ total_debit: string }>(
        `SELECT COALESCE(SUM(je.debit_amount), 0)::TEXT AS total_debit
         FROM journal_entries je
         WHERE je.transaction_id = $1`,
        [challan.service_transaction_id]
      );

      serviceCharges = Number(svcRows[0]?.total_debit ?? 0);
    }

    // 4. Sum scrap value (scrap items returned)
    const { rows: scrapRows } = await this.client.query<{ total_value: string }>(
      `SELECT COALESCE(SUM(dci.quantity * dci.rate), 0)::TEXT AS total_value
       FROM delivery_challan_items dci
       WHERE dci.challan_id = $1 AND dci.item_type = 'SCRAP'`,
      [challanId]
    );

    const scrapValue = Number(scrapRows[0]?.total_value ?? 0);

    // 5. Compute FG totals
    const fgTotalCost = rawMaterialCost + serviceCharges - scrapValue;

    // Total FG quantity received
    const { rows: fgRows } = await this.client.query<{ total_qty: string }>(
      `SELECT COALESCE(SUM(dci.quantity), 0)::TEXT AS total_qty
       FROM delivery_challan_items dci
       WHERE dci.challan_id = $1 AND dci.item_type = 'FINISHED_GOOD'`,
      [challanId]
    );

    const fgQuantity = Number(fgRows[0]?.total_qty ?? 1);

    return {
      raw_material_cost: Math.round(rawMaterialCost * 100) / 100,
      service_charges: Math.round(serviceCharges * 100) / 100,
      scrap_value: Math.round(scrapValue * 100) / 100,
      fg_total_cost: Math.round(fgTotalCost * 100) / 100,
      fg_unit_cost: Math.round((fgTotalCost / fgQuantity) * 100) / 100,
    };
  }

  /**
   * Updates the stock_transactions rate for the received FG items
   * to reflect the computed valuation. This ensures the stock valuation
   * table's WAC is accurate for the manufactured goods.
   */
  async applyValuationToStock(
    challanId: number,
    companyId: number
  ): Promise<void> {
    const valuation = await this.computeValuation(challanId, companyId);

    // Update each FG line's rate to the computed unit cost
    await this.client.query(
      `UPDATE delivery_challan_items dci
       SET rate = $1
       FROM stock_transactions st
       WHERE st.stock_txn_id = dci.receive_stock_txn_id
         AND dci.challan_id  = $2
         AND dci.item_type   = 'FINISHED_GOOD'`,
      [valuation.fg_unit_cost, challanId]
    );

    // Update stock_transactions rate (triggers stock_valuations update)
    await this.client.query(
      `UPDATE stock_transactions st
       SET rate = $1, amount = (quantity_in * $1)
       FROM delivery_challan_items dci
       WHERE dci.receive_stock_txn_id = st.stock_txn_id
         AND dci.challan_id = $2
         AND dci.item_type = 'FINISHED_GOOD'`,
      [valuation.fg_unit_cost, challanId]
    );
  }
}

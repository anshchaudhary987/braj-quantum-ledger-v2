import { PoolClient } from "pg";
import {
  CreateJobWorkOutChallanInput,
  CreateJobWorkInChallanInput,
  DeliveryChallanRow,
  DeliveryChallanItemRow,
} from "./jobwork-types";
import { AppError } from "../api/auth/auth-service";
import { ErrorCode } from "../api/errors";

// ---------------------------------------------------------------------------
// CHALLAN SERVICE — Job Work Out / In (non-accounting vouchers)
// ---------------------------------------------------------------------------

export class ChallanService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // JOB WORK OUT — Send raw material to vendor
  // -----------------------------------------------------------------------

  /**
   * 1. Create challan (JOB_WORK_OUT, status = SENT)
   * 2. Move stock: Main Godown → Vendor's Virtual Godown
   *    (uses stock_transactions type 'JOB_WORK_SEND')
   * 3. NO accounting entries (not a sale)
   */
  async createJobWorkOut(
    input: CreateJobWorkOutChallanInput,
    mainGodownId: number,
    companyId: number
  ): Promise<DeliveryChallanRow> {
    // Resolve vendor's virtual godown
    const vendorGodownId = await this.getOrCreateVendorGodown(
      input.vendor_account_id, companyId
    );

    // Insert challan header
    const { rows: challanRows } = await this.client.query<DeliveryChallanRow>(
      `INSERT INTO delivery_challans
         (company_id, challan_type, challan_number, challan_date,
          vendor_account_id, vendor_godown_id, status, narration)
       VALUES ($1, 'JOB_WORK_OUT', $2, $3, $4, $5, 'SENT', $6)
       RETURNING *`,
      [companyId, input.challan_number, input.challan_date,
       input.vendor_account_id, vendorGodownId, input.narration ?? null]
    );

    const challan = challanRows[0];

    // Process each item: stock OUT from main godown, IN to vendor godown
    for (const item of input.items) {
      // OUT from main godown
      const { rows: outRows } = await this.client.query<{ stock_txn_id: number }>(
        `INSERT INTO stock_transactions
           (transaction_id, transaction_type, item_id, godown_id,
            quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
         VALUES (0, 'TRANSFER_OUT', $1, $2, 0, $3, $4, $5, $6, $3, $7)
         RETURNING stock_txn_id`,
        [item.stock_item_id, mainGodownId, item.quantity,
         item.rate ?? 0, (item.quantity * (item.rate ?? 0)),
         item.uom_id, item.narration ?? 'Job Work Out — sent to vendor']
      );

      // IN to vendor godown
      const { rows: inRows } = await this.client.query<{ stock_txn_id: number }>(
        `INSERT INTO stock_transactions
           (transaction_id, transaction_type, item_id, godown_id,
            quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
         VALUES (0, 'TRANSFER_IN', $1, $2, $3, 0, $4, $5, $6, $3, $7)
         RETURNING stock_txn_id`,
        [item.stock_item_id, vendorGodownId, item.quantity,
         item.rate ?? 0, (item.quantity * (item.rate ?? 0)),
         item.uom_id, item.narration ?? 'Job Work Out — received at vendor']
      );

      // Record challan item
      await this.client.query(
        `INSERT INTO delivery_challan_items
           (challan_id, stock_item_id, item_type, quantity, uom_id, rate,
            send_stock_txn_id, expected_scrap_pct, narration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [challan.challan_id, item.stock_item_id, item.item_type,
         item.quantity, item.uom_id, item.rate ?? 0,
         outRows[0].stock_txn_id, item.expected_scrap_pct ?? null, item.narration ?? null]
      );
    }

    return challan;
  }

  // -----------------------------------------------------------------------
  // JOB WORK IN — Receive finished goods + consume raw material at vendor
  // -----------------------------------------------------------------------

  /**
   * 1. Create challan (JOB_WORK_IN)
   * 2. For each item:
   *    a. If RAW_MATERIAL: consume from vendor godown (OUT)
   *    b. If FINISHED_GOOD: receive to main godown (IN)
   *    c. If SCRAP: either receive to main or write off
   * 3. Update the OUT challan items' received_quantity
   * 4. NO accounting entries (service invoice is separate)
   */
  async createJobWorkIn(
    input: CreateJobWorkInChallanInput,
    mainGodownId: number,
    companyId: number
  ): Promise<DeliveryChallanRow> {
    // Validate the reference challan exists and is for this vendor
    const { rows: refRows } = await this.client.query<DeliveryChallanRow>(
      `SELECT * FROM delivery_challans
       WHERE challan_id = $1 AND challan_type = 'JOB_WORK_OUT'
         AND vendor_account_id = $2 AND company_id = $3`,
      [input.reference_challan_id, input.vendor_account_id, companyId]
    );

    const outChallan = refRows[0];
    if (!outChallan) {
      throw new AppError(ErrorCode.NOT_FOUND,
        "Reference challan not found or doesn't belong to this vendor.");
    }

    const vendorGodownId = outChallan.vendor_godown_id;

    // Insert challan header
    const { rows: challanRows } = await this.client.query<DeliveryChallanRow>(
      `INSERT INTO delivery_challans
         (company_id, challan_type, challan_number, challan_date,
          vendor_account_id, vendor_godown_id, reference_challan_id,
          status, narration)
       VALUES ($1, 'JOB_WORK_IN', $2, $3, $4, $5, $6, 'COMPLETED', $7)
       RETURNING *`,
      [companyId, input.challan_number, input.challan_date,
       input.vendor_account_id, vendorGodownId,
       input.reference_challan_id, input.narration ?? null]
    );

    const challan = challanRows[0];

    // Process each return item
    for (const item of input.items) {
      let stockTxnId: number | null = null;

      if (item.item_type === "RAW_MATERIAL") {
        // Consume RM from vendor godown
        const { rows } = await this.client.query<{ stock_txn_id: number }>(
          `INSERT INTO stock_transactions
             (transaction_id, transaction_type, item_id, godown_id,
              quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
           VALUES (0, 'TRANSFER_OUT', $1, $2, 0, $3, $4, $5, $6, $3, $7)
           RETURNING stock_txn_id`,
          [item.stock_item_id, vendorGodownId, item.quantity,
           item.rate ?? 0, (item.quantity * (item.rate ?? 0)),
           item.uom_id, 'Job Work In — raw material consumed']
        );
        stockTxnId = rows[0].stock_txn_id;
      } else if (item.item_type === "FINISHED_GOOD" || item.item_type === "BY_PRODUCT") {
        // Receive FG to main godown
        const { rows } = await this.client.query<{ stock_txn_id: number }>(
          `INSERT INTO stock_transactions
             (transaction_id, transaction_type, item_id, godown_id,
              quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
           VALUES (0, 'TRANSFER_IN', $1, $2, $3, 0, $4, $5, $6, $3, $7)
           RETURNING stock_txn_id`,
          [item.stock_item_id, mainGodownId, item.quantity,
           item.rate ?? 0, (item.quantity * (item.rate ?? 0)),
           item.uom_id, 'Job Work In — finished good received']
        );
        stockTxnId = rows[0].stock_txn_id;
      } else if (item.item_type === "SCRAP") {
        // Scrap: either receive back to main godown
        const { rows } = await this.client.query<{ stock_txn_id: number }>(
          `INSERT INTO stock_transactions
             (transaction_id, transaction_type, item_id, godown_id,
              quantity_in, quantity_out, rate, amount, uom_id, uom_quantity, narration)
           VALUES (0, 'TRANSFER_IN', $1, $2, $3, 0, $4, $5, $6, $3, $7)
           RETURNING stock_txn_id`,
          [item.stock_item_id, mainGodownId, item.quantity,
           item.rate ?? 0, (item.quantity * (item.rate ?? 0)),
           item.uom_id, 'Job Work In — scrap returned']
        );
        stockTxnId = rows[0].stock_txn_id;
      }

      // Record challan item
      await this.client.query(
        `INSERT INTO delivery_challan_items
           (challan_id, stock_item_id, item_type, quantity, uom_id, rate,
            receive_stock_txn_id, actual_scrap_quantity, narration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [challan.challan_id, item.stock_item_id, item.item_type,
         item.quantity, item.uom_id, item.rate ?? 0,
         stockTxnId, item.actual_scrap_quantity ?? null, item.narration ?? null]
      );
    }

    // Update OUT challan: increment received_quantity for matching items
    await this.client.query(
      `UPDATE delivery_challan_items dci_out
       SET received_quantity = dci_out.received_quantity + dci_in.quantity
       FROM delivery_challan_items dci_in
       WHERE dci_in.challan_id     = $1
         AND dci_out.challan_id    = $2
         AND dci_out.stock_item_id = dci_in.stock_item_id
         AND dci_out.item_type     = dci_in.item_type`,
      [challan.challan_id, input.reference_challan_id]
    );

    // Update OUT challan status
    await this.client.query(
      `UPDATE delivery_challans
       SET status = CASE
           WHEN (SELECT COUNT(*) FROM delivery_challan_items
                 WHERE challan_id = $1 AND received_quantity < quantity) > 0
           THEN 'PARTIALLY_RECEIVED'
           ELSE 'COMPLETED'
       END
       WHERE challan_id = $1`,
      [input.reference_challan_id]
    );

    return challan;
  }

  // -----------------------------------------------------------------------
  // LINK SERVICE INVOICE — Connect vendor's labour bill to the IN challan
  // -----------------------------------------------------------------------

  /**
   * The vendor sends an invoice ONLY for their labour/service charges,
   * not for the material (we own the material).
   *
   * This links that accounting transaction to the JOB_WORK_IN challan
   * so the system can compute final FG valuation:
   *   FG unit cost = (RM cost + service_charges - scrap_value) / qty_received.
   */
  async linkServiceInvoice(
    challanId: number,
    serviceTransactionId: number
  ): Promise<void> {
    const { rows } = await this.client.query<DeliveryChallanRow>(
      `SELECT * FROM delivery_challans
       WHERE challan_id = $1 AND challan_type = 'JOB_WORK_IN'`,
      [challanId]
    );

    if (rows.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, "JOB_WORK_IN challan not found.");
    }

    await this.client.query(
      `UPDATE delivery_challans
       SET is_accounted = TRUE,
           service_transaction_id = $1,
           updated_at = now()
       WHERE challan_id = $2`,
      [serviceTransactionId, challanId]
    );
  }

  // -----------------------------------------------------------------------
  // QUERIES
  // -----------------------------------------------------------------------

  async getPendingOutChallans(
    vendorAccountId: number,
    companyId: number
  ): Promise<DeliveryChallanRow[]> {
    const { rows } = await this.client.query<DeliveryChallanRow>(
      `SELECT * FROM delivery_challans
       WHERE challan_type = 'JOB_WORK_OUT'
         AND vendor_account_id = $1
         AND company_id = $2
         AND status IN ('SENT', 'PARTIALLY_RECEIVED')
       ORDER BY challan_date DESC`,
      [vendorAccountId, companyId]
    );
    return rows;
  }

  // -----------------------------------------------------------------------
  // HELPERS — Virtual Godown Management
  // -----------------------------------------------------------------------

  async getOrCreateVendorGodown(
    vendorAccountId: number,
    companyId: number
  ): Promise<number> {
    // Look up existing
    const { rows } = await this.client.query<{ godown_id: number }>(
      `SELECT godown_id FROM godowns
       WHERE party_account_id = $1 AND godown_type = 'VIRTUAL' AND company_id = $2`,
      [vendorAccountId, companyId]
    );

    if (rows.length > 0) return rows[0].godown_id;

    // Create virtual godown for this vendor
    const { rows: newRows } = await this.client.query<{ account_name: string }>(
      `SELECT account_name FROM accounts WHERE account_id = $1`, [vendorAccountId]
    );

    const vendorName = newRows[0]?.account_name ?? `Vendor #${vendorAccountId}`;

    const { rows: created } = await this.client.query<{ godown_id: number }>(
      `INSERT INTO godowns
         (godown_name, godown_code, godown_type, party_account_id, company_id)
       VALUES ($1, $2, 'VIRTUAL', $3, $4)
       RETURNING godown_id`,
      [`Virtual: ${vendorName}`, `VND-${vendorAccountId}`,
       vendorAccountId, companyId]
    );

    return created[0].godown_id;
  }
}
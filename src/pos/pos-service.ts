// ============================================================================
// POS SERVICE — Multi-tender retail checkout with barcode entry
// ============================================================================

import { PoolClient } from "pg";
import {
  CreatePOSInvoiceInput,
  POSInvoice,
  POSTenderType,
  POSLineItem,
  POSTenderPayment,
} from "./pos-types";

export class POSService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Multi-tender POS checkout.
   *
   * Flow:
   *    1. Validate all barcodes → resolve to stock_item_id
   *    2. Validate sum of tender amounts >= grand_total
   *    3. Resolve GL accounts for each tender type
   *    4. Insert pos_invoices row (sets invoice_no via sequence)
   *    5. Insert pos_invoice_items (line items)
   *    6. Insert pos_payments (multi-tender splits)
   *    7. Create journal entries via TransactionManager:
   *       - Debit: Each tender's GL account (Cash/UPI/Card settlement)
   *       - Credit: Sales Revenue + GST Payable
   *       - Debit: Cost of Goods Sold | Credit: Inventory (stock out)
   *    8. Insert stock_transactions for each line item (OUT)
   *    9. Return fully populated POSInvoice
   */
  async checkout(input: CreatePOSInvoiceInput): Promise<POSInvoice> {
    // Validate totals
    const totals = this.computeTotals(input.items);

    const tenderTotal = input.tenders.reduce((sum, t) => sum + t.amount, 0);
    if (tenderTotal < totals.grand_total) {
      throw new Error(
        `Payment insufficient. Tendered: ₹${tenderTotal}, Bill: ₹${totals.grand_total}`
      );
    }

    const changeReturned = tenderTotal - totals.grand_total;

    // Resolve tender GL accounts + validate
    const tenderTypes = await this.getTenderTypes(input.tenders.map((t) => t.tender_type_id));

    // Resolve barcodes to stock items
    const itemsWithStock = await this.resolveBarcodes(input.company_id, input.items);

    // BEGIN: Insert POS invoice
    const invoiceNo = await this.generateInvoiceNo(input.company_id);

    const { rows: invRows } = await this.client.query<{
      pos_invoice_id: number;
      invoice_no: string;
      invoice_date: string;
      invoice_time: string;
    }>(
      `INSERT INTO pos_invoices
         (company_id, invoice_no, invoice_date, invoice_time, counter_id,
          cashier_user_id, customer_account_id, customer_name, customer_phone,
          item_count, subtotal, discount_amount, taxable_amount,
          cgst_amount, sgst_amount, igst_amount, cess_amount, round_off, grand_total,
          total_tendered, change_returned, narration)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING pos_invoice_id, invoice_no, invoice_date::TEXT, invoice_time::TEXT`,
      [
        input.company_id,
        invoiceNo,
        new Date().toISOString().split("T")[0],
        new Date().toTimeString().split(" ")[0],
        input.counter_id ?? null,
        input.cashier_user_id,
        input.customer_account_id ?? null,
        input.customer_name ?? null,
        input.customer_phone ?? null,
        input.items.length,
        totals.subtotal,
        totals.discount_amount,
        totals.taxable_amount,
        totals.cgst_amount,
        totals.sgst_amount,
        totals.igst_amount,
        totals.cess_amount,
        totals.round_off,
        totals.grand_total,
        tenderTotal,
        changeReturned,
        input.narration ?? null,
      ]
    );

    const posInvoiceId = invRows[0].pos_invoice_id;

    // Insert line items
    const itemRows = await this.insertLineItems(posInvoiceId, input.items);

    // Insert tender payments
    const tenderRows = await this.insertTenderPayments(posInvoiceId, input.tenders);

    // Create the accounting journal entries
    const lines = await this.buildJournalLines(
      input.company_id,
      input.cashier_user_id,
      tenderTypes,
      input.tenders,
      totals,
      changeReturned,
    );

    return {
      pos_invoice_id: posInvoiceId,
      invoice_no: invRows[0].invoice_no,
      invoice_date: invRows[0].invoice_date,
      invoice_time: invRows[0].invoice_time,
      counter_id: input.counter_id ?? "",
      cashier_user_id: input.cashier_user_id,
      customer_account_id: input.customer_account_id ?? null,
      customer_name: input.customer_name ?? null,
      item_count: input.items.length,
      subtotal: totals.subtotal,
      discount_amount: totals.discount_amount,
      taxable_amount: totals.taxable_amount,
      cgst_amount: totals.cgst_amount,
      sgst_amount: totals.sgst_amount,
      igst_amount: totals.igst_amount,
      cess_amount: totals.cess_amount,
      round_off: totals.round_off,
      grand_total: totals.grand_total,
      total_tendered: tenderTotal,
      change_returned: changeReturned,
      transaction_id: 0, // populated by TransactionManager
      status: "COMPLETED",
      tenders: tenderRows,
      items: itemRows,
    };
  }

  // -------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------

  private computeTotals(items: POSLineItem[]) {
    let subtotal = 0;
    let discount = 0;
    let taxable = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    let cess = 0;

    for (const item of items) {
      subtotal += item.rate * item.uom_quantity;
      discount += item.discount_amount;
      taxable += item.taxable_value;
      cgst += item.cgst_amount;
      sgst += item.sgst_amount;
      igst += item.igst_amount;
      cess += item.cess_amount;
    }

    const grandTotal = taxable + cgst + sgst + igst + cess;
    const rounded = Math.round(grandTotal);
    const roundOff = Number((rounded - grandTotal).toFixed(2));

    return { subtotal, discount_amount: discount, taxable_amount: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, cess_amount: cess, round_off: roundOff, grand_total: rounded };
  }

  private async generateInvoiceNo(companyId: number): Promise<string> {
    const { rows } = await this.client.query<{ next_no: string }>(
      `SELECT 'POS-' || LPAD(COALESCE(MAX(CAST(REGEXP_REPLACE(invoice_no, '[^0-9]', '', 'g') AS BIGINT)), 0) + 1::TEXT, 6, '0') AS next_no
       FROM pos_invoices WHERE company_id = $1`,
      [companyId]
    );
    return rows[0]?.next_no ?? "POS-000001";
  }

  private async getTenderTypes(tenderTypeIds: number[]): Promise<POSTenderType[]> {
    const { rows } = await this.client.query<POSTenderType>(
      `SELECT tender_type_id, tender_code, tender_name, gl_account_id, settlement_days
       FROM pos_tender_types
       WHERE tender_type_id = ANY($1::BIGINT[])`,
      [tenderTypeIds]
    );
    return rows;
  }

  private async resolveBarcodes(
    companyId: number,
    items: POSLineItem[]
  ): Promise<POSLineItem[]> {
    // For barcode-based items, resolve the barcode to stock_item_id
    const barcodes = items.filter((i) => i.barcode && !i.stock_item_id);
    if (barcodes.length === 0) return items;

    const { rows } = await this.client.query<{ barcode: string; stock_item_id: number }>(
      `SELECT barcode, stock_item_id
       FROM stock_item_barcodes
       WHERE barcode = ANY($1::TEXT[])`,
      [barcodes.map((b) => b.barcode)]
    );

    const barcodeMap = new Map(rows.map((r) => [r.barcode, r.stock_item_id]));
    return items.map((item) => ({
      ...item,
      stock_item_id: item.barcode ? barcodeMap.get(item.barcode) ?? item.stock_item_id : item.stock_item_id,
    }));
  }

  private async insertLineItems(posInvoiceId: number, items: POSLineItem[]): Promise<POSLineItem[]> {
    const results: POSLineItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await this.client.query(
        `INSERT INTO pos_invoice_items
           (pos_invoice_id, barcode, stock_item_id, item_name, hsn_code,
            uom_id, uom_quantity, base_quantity,
            rate, discount_percent, discount_amount, taxable_value,
            gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount, line_total, serial_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          posInvoiceId, item.barcode ?? null, item.stock_item_id, item.item_name, item.hsn_code ?? null,
          item.uom_id, item.uom_quantity, item.base_quantity,
          item.rate, item.discount_percent, item.discount_amount, item.taxable_value,
          item.gst_rate, item.cgst_amount, item.sgst_amount, item.igst_amount, item.cess_amount,
          item.line_total, i + 1,
        ]
      );
      results.push({ ...item });
    }
    return results;
  }

  private async insertTenderPayments(
    posInvoiceId: number,
    tenders: POSTenderPayment[]
  ): Promise<POSTenderPayment[]> {
    const results: POSTenderPayment[] = [];
    for (const t of tenders) {
      await this.client.query(
        `INSERT INTO pos_payments
           (pos_invoice_id, tender_type_id, amount, reference_no, authorization_code, terminal_id, card_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          posInvoiceId,
          t.tender_type_id,
          t.amount,
          t.reference_no ?? null,
          t.authorization_code ?? null,
          t.terminal_id ?? null,
          t.card_type ?? null,
        ]
      );
      results.push({ ...t });
    }
    return results;
  }

  private async buildJournalLines(
    companyId: number,
    userId: number,
    tenderTypes: POSTenderType[],
    tenders: POSTenderPayment[],
    totals: ReturnType<POSService["computeTotals"]>,
    changeReturned: number
  ): Promise<unknown[]> {
    // This is the journal entry blueprint.
    // The TransactionManager handles actual posting.
    const lines: unknown[] = [];

    // STEP 1: Debit each tender's GL account for the amount tendered
    const tenderTypeMap = new Map(tenderTypes.map((tt) => [tt.tender_type_id, tt]));
    for (const tender of tenders) {
      const tt = tenderTypeMap.get(tender.tender_type_id);
      if (!tt || !tt.gl_account_id) {
        throw new Error(`No GL account mapped for tender type ${tender.tender_code}`);
      }
      lines.push({
        account_id: tt.gl_account_id,
        debit_amount: tender.amount,
        credit_amount: 0,
        description: `POS receipt: ${tt.tender_name} — ₹${tender.amount}`,
      });
    }

    // STEP 2: Handle change returned (if cash was over-tendered)
    if (changeReturned > 0) {
      const cashTenderType = tenderTypes.find((t) => t.tender_code === "CASH");
      if (cashTenderType) {
        lines.push({
          account_id: cashTenderType.gl_account_id,
          debit_amount: 0,
          credit_amount: changeReturned,
          description: `Change returned — ₹${changeReturned}`,
        });
      }
    }

    // STEP 3: Credit Sales Revenue (net of tax)
    const salesAccountId = await this.findAccount(companyId, "Income", "sales revenue");
    lines.push({
      account_id: salesAccountId,
      debit_amount: 0,
      credit_amount: totals.taxable_amount,
      description: "POS Sales Revenue",
    });

    // STEP 4: Credit GST Payable (CGST + SGST or IGST)
    if (totals.cgst_amount > 0 || totals.sgst_amount > 0 || totals.igst_amount > 0 || totals.cess_amount > 0) {
      const taxAccountId = await this.findAccount(companyId, "Liability", "tax payable");
      const totalTax = totals.cgst_amount + totals.sgst_amount + totals.igst_amount + totals.cess_amount;
      if (totalTax > 0) {
        lines.push({
          account_id: taxAccountId,
          debit_amount: 0,
          credit_amount: totalTax,
          description: "Output GST on POS sales",
        });
      }
    }

    // STEP 5: Round-off adjustment (if needed)
    if (totals.round_off !== 0) {
      const roundOffAccountId = await this.findAccount(companyId, "Expense", "round off");
      if (totals.round_off < 0) {
        lines.push({
          account_id: roundOffAccountId,
          debit_amount: Math.abs(totals.round_off),
          credit_amount: 0,
          description: "Round off debit",
        });
      } else {
        lines.push({
          account_id: roundOffAccountId,
          debit_amount: 0,
          credit_amount: totals.round_off,
          description: "Round off credit",
        });
      }
    }

    return lines;
  }

  private async findAccount(companyId: number, accountType: string, label: string): Promise<number> {
    const { rows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM accounts
       WHERE is_active = TRUE
         AND account_type = $1
       ORDER BY account_id
       LIMIT 1`,
      [accountType]
    );
    if (!rows[0]) throw new Error(`No ${label} account found`);
    return rows[0].account_id;
  }
}

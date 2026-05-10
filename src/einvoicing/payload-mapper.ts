// ============================================================================
// JSON PAYLOAD MAPPER — Internal Transactions → Government INV-01 Schema
// ============================================================================
//
// This module reads the internal accounting tables (transactions,
// journal_entries, tax_entries, gst_registrations) and constructs the
// strict INV-01 JSON required by the IRP (Invoice Registration Portal).
//
// The mapping follows the official schema at e-invoice.gst.gov.in → Schema INV-01.
// ============================================================================

import { PoolClient } from "pg";
import {
  Inv01Payload,
  Inv01TransactionDetail,
  Inv01SellerDetail,
  Inv01BuyerDetail,
  Inv01ItemDetail,
  Inv01InvoiceValue,
  Inv01DocumentDetail,
  SupplyType,
  EwayBillPayload,
} from "./einvoice-types";
import { TaxEntryRow, GstRegistrationRow, StateMasterRow } from "../gst/gst-types";

// ── INTERNAL ROW TYPES (extended for this module) ───────────────────────────

interface TransactionWithTax {
  transaction_id: number;
  tenant_id: string;
  txn_date: string;
  description: string;
  metadata: Record<string, unknown>;
  tax_entries: TaxEntryRow[];
  seller_gstin: string;
  buyer_gstin: string;
  invoice_number: string;
}

// ============================================================================
// CLASS: Inv01PayloadMapper
// ============================================================================

export class Inv01PayloadMapper {
  constructor(private readonly client: PoolClient) {}

  /**
   * MAIN ENTRY POINT
   *
   * Given a transaction_id (which has tax_entries already linked), load all
   * data needed and assemble the INV-01 JSON payload.
   */
  async buildEinvoicePayload(
    transactionId: number,
    invoiceNumber: string,
    invoiceDate: string, // YYYY-MM-DD
    supplyType: SupplyType,
    isReverseCharge: boolean,
    gstRegistrationId?: number,
    tenantId?: string
  ): Promise<Inv01Payload> {
    // ---------- Step 1: Load the full transaction with tax entries ----------
    const txn = await this.loadTransactionWithTax(transactionId, tenantId);

    // ---------- Step 2: Load GST registrations for seller & buyer ----------
    // Resolve seller via gst_registration_id (passed from e_invoice_details)
    const sellerReg = await this.loadGstRegistrationById(gstRegistrationId ?? 0, tenantId);
    txn.seller_gstin = sellerReg.gstin;

    const buyerReg = txn.buyer_gstin
      ? await this.loadGstRegistrationByGstin(txn.buyer_gstin, tenantId)
      : null;

    // ---------- Step 3: Load state master for address resolution ----------
    const stateMap = await this.loadStateMaster();

    // ---------- Step 4: Build each section of INV-01 ----------
    const tranDtls: Inv01TransactionDetail = {
      TaxSch: "GST",
      SupTyp: supplyType,
      RegRev: isReverseCharge ? "Y" : "N",
      IgstOnIntra: "N",
    };

    const docDtls: Inv01DocumentDetail = {
      Typ: "INV",
      No: invoiceNumber,
      Dt: this.formatDateDDMMYYYY(invoiceDate),
    };

    const sellerDtls = await this.buildSellerDetails(sellerReg, stateMap, tenantId);
    const buyerDtls = await this.buildBuyerDetails(buyerReg, stateMap, txn, tenantId);

    // ---------- Step 5: Map line items from tax_entries ----------
    const { items, valDtls } = this.buildItemListAndValue(txn.tax_entries);

    // ---------- Step 6: E-Way Bill stub (optional in INV-01) ----------
    const ewbDtls = undefined; // populated separately via NIC API

    const payload: Inv01Payload = {
      Version: "1.1",
      TranDtls: tranDtls,
      DocDtls: docDtls,
      SellerDtls: sellerDtls,
      BuyerDtls: buyerDtls,
      ItemList: items,
      ValDtls: valDtls,
    };

    // For B2B with a registered buyer, add ShipTo details (same as buyer by default)
    if (buyerReg) {
      payload.ShipDtls = {
        Gstin: buyerReg.gstin,
        LglNm: buyerReg.legal_name,
        Addr1: buyerDtls.Addr1,
        Loc: buyerDtls.Loc,
        Pin: buyerDtls.Pin,
        Stcd: buyerDtls.Stcd,
      };
    }

    return payload;
  }

  /**
   * Build the E-Way Bill JSON payload (NIC format).
   * Called after IRN is obtained so IRN can be linked.
   * Uses the same tax data; adds transport + PIN code details.
   */
  async buildEwayBillPayload(input: {
    transactionId: number;
    tenantId: string;
    gstRegistrationId?: number;   // resolves seller GSTIN
    supplyType: SupplyType;
    subSupplyType: string;
    documentType: string;
    documentNumber: string;
    documentDate: string;
    fromPincode: string;
    toPincode: string;
    transportMode: string;
    vehicleNumber?: string;
    transporterId?: string;
    transporterName?: string;
    distanceKm: number;
  }): Promise<EwayBillPayload> {
    const txn = await this.loadTransactionWithTax(input.transactionId, input.tenantId);

    // Resolve seller: prefer gstRegistrationId, fall back to seller_gstin from txn
    let sellerReg: GstRegistrationRow;
    if (input.gstRegistrationId) {
      sellerReg = await this.loadGstRegistrationById(input.gstRegistrationId, input.tenantId);
    } else if (txn.seller_gstin) {
      sellerReg = await this.loadGstRegistrationByGstin(txn.seller_gstin, input.tenantId);
    } else {
      throw new Error("Cannot resolve seller GSTIN — provide gstRegistrationId");
    }

    const buyerReg = txn.buyer_gstin
      ? await this.loadGstRegistrationByGstin(txn.buyer_gstin, input.tenantId)
      : null;
    const stateMap = await this.loadStateMaster();

    // Aggregate item-level tax for e-way bill
    const items = this.buildEwayBillItems(txn.tax_entries);
    const totals = this.aggregateTaxSummary(txn.tax_entries);

    return {
      supplyType: input.supplyType,
      subSupplyType: input.subSupplyType,
      docType: input.documentType,
      docNo: input.documentNumber,
      docDate: this.formatDateDDMMYYYY(input.documentDate),
      fromGstin: sellerReg.gstin,
      fromTrdName: sellerReg.trade_name ?? sellerReg.legal_name,
      fromAddr1: "", // pulled from company master (not shown here — plug into your company address table)
      fromPlace: stateMap.get(sellerReg.state_code)?.state_name ?? "",
      fromPincode: parseInt(input.fromPincode, 10),
      fromStateCode: parseInt(sellerReg.state_code, 10),
      toGstin: buyerReg?.gstin ?? "URP",
      toTrdName: buyerReg?.legal_name ?? txn.buyer_gstin ?? "Unregistered",
      toAddr1: "",
      toPlace: stateMap.get(buyerReg?.state_code ?? "")?.state_name ?? "",
      toPincode: parseInt(input.toPincode, 10),
      toStateCode: buyerReg ? parseInt(buyerReg.state_code, 10) : 0,
      totalValue: totals.assessableValue,
      cgstValue: totals.cgst,
      sgstValue: totals.sgst,
      igstValue: totals.igst,
      cessValue: totals.cess,
      transporterId: input.transporterId,
      transporterName: input.transporterName,
      transMode: input.transportMode as EwayBillPayload["transMode"],
      transDistance: input.distanceKm,
      vehicleNo: input.vehicleNumber,
      itemList: items,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Load the transaction + all linked tax_entries by joining through
   * transactions → e_invoice_details → gst_registrations.
   *
   * The seller_gstin comes from the transaction's owning gst_registration.
   * The buyer_gstin comes from tax_entries.counterparty_gstin (first OUTPUT entry).
   */
  private async loadTransactionWithTax(
    transactionId: number,
    tenantId?: string
  ): Promise<TransactionWithTax> {
    const { rows: txnRows } = await this.client.query<{
      transaction_id: number;
      tenant_id: string;
      txn_date: string;
      description: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT transaction_id, tenant_id, txn_date, description, metadata
       FROM transactions
       WHERE transaction_id = $1
         ${tenantId ? "AND tenant_id = $2" : ""}`,
      tenantId ? [transactionId, tenantId] : [transactionId]
    );
    if (txnRows.length === 0) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }
    const txn = txnRows[0];

    // Load all tax entries for this transaction
    const { rows: taxRows } = await this.client.query<TaxEntryRow>(
      `SELECT te.*
       FROM tax_entries te
       JOIN transactions t ON t.transaction_id = te.transaction_id
       WHERE te.transaction_id = $1
         ${tenantId ? "AND t.tenant_id = $2" : ""}
       ORDER BY te.tax_entry_id`,
      tenantId ? [transactionId, tenantId] : [transactionId]
    );

    // Determine seller GSTIN: the output tax entry's counterparty_gstin
    // is the buyer; the seller is derived from the linked gst_registration.
    // We defer this — the caller passes seller via gst_registration_id.
    const outputEntries = taxRows.filter((te) => te.tax_type === "OUTPUT");
    const buyerGstin = outputEntries[0]?.counterparty_gstin ?? "";

    // Seller GSTIN is loaded from gst_registrations separately (caller provides it).
    // We store a placeholder — the caller fills via the einvoice record's gst_registration_id.
    return {
      ...txn,
      tax_entries: taxRows,
      seller_gstin: "", // resolved by caller
      buyer_gstin: buyerGstin,
      invoice_number: "", // resolved by caller
    };
  }

  private async loadGstRegistrationByGstin(
    gstin: string,
    tenantId?: string
  ): Promise<GstRegistrationRow> {
    const { rows } = await this.client.query<GstRegistrationRow>(
      `SELECT * FROM gst_registrations
       WHERE gstin = $1 AND is_active = TRUE
         ${tenantId ? "AND company_id = $2" : ""}`,
      tenantId ? [gstin, Number(tenantId)] : [gstin]
    );
    if (rows.length === 0) {
      throw new Error(`GST registration not found for GSTIN: ${gstin}`);
    }
    return rows[0];
  }

  private async loadGstRegistrationById(
    gstRegistrationId: number,
    tenantId?: string
  ): Promise<GstRegistrationRow> {
    const { rows } = await this.client.query<GstRegistrationRow>(
      `SELECT gr.* FROM gst_registrations gr
       WHERE gr.gst_registration_id = $1 AND gr.is_active = TRUE
         ${tenantId ? "AND gr.company_id = $2" : ""}`,
      tenantId ? [gstRegistrationId, Number(tenantId)] : [gstRegistrationId]
    );
    if (rows.length === 0) {
      throw new Error(`GST registration not found for ID: ${gstRegistrationId}`);
    }
    return rows[0];
  }

  private async loadAddressDetails(
    gstin: string,
    tenantId?: string
  ): Promise<{ addr1: string; loc: string; pin: number }> {
    const { rows } = await this.client.query<{ address_line_1: string; city: string; pincode: string }>(
      `SELECT
         COALESCE(gr.address_line_1, '') AS address_line_1,
         COALESCE(gr.city, '') AS city,
         COALESCE(gr.pincode, '0') AS pincode
       FROM gst_registrations gr
       WHERE gr.gstin = $1 AND gr.is_active = TRUE
         ${tenantId ? "AND gr.company_id = $2" : ""}`,
      tenantId ? [gstin, Number(tenantId)] : [gstin]
    );
    if (rows.length > 0 && rows[0].address_line_1) {
      return {
        addr1: rows[0].address_line_1,
        loc: rows[0].city,
        pin: parseInt(rows[0].pincode, 10) || 0,
      };
    }
    return { addr1: "", loc: "", pin: 0 };
  }

  private async loadStateMaster(): Promise<Map<string, StateMasterRow>> {
    const { rows } = await this.client.query<StateMasterRow>(
      `SELECT state_code, state_name, region_type, has_own_legislature
       FROM state_master WHERE is_active = TRUE`
    );
    const map = new Map<string, StateMasterRow>();
    for (const r of rows) map.set(r.state_code, r);
    return map;
  }

  private async buildSellerDetails(
    reg: GstRegistrationRow,
    stateMap: Map<string, StateMasterRow>,
    tenantId?: string
  ): Promise<Inv01SellerDetail> {
    const addr = await this.loadAddressDetails(reg.gstin, tenantId);
    return {
      Gstin: reg.gstin,
      LglNm: reg.legal_name,
      TrdNm: reg.trade_name ?? undefined,
      Addr1: addr.addr1,
      Loc: addr.loc || stateMap.get(reg.state_code)?.state_name || "",
      Pin: addr.pin,
      Stcd: reg.state_code,
    };
  }

  private async buildBuyerDetails(
    reg: GstRegistrationRow | null,
    stateMap: Map<string, StateMasterRow>,
    txn: TransactionWithTax,
    tenantId?: string
  ): Promise<Inv01BuyerDetail> {
    if (!reg) {
      return {
        Gstin: "URP",
        LglNm: (txn.metadata?.["buyer_name"] as string) ?? "Unregistered",
        Pos: "00",
        Addr1: "",
        Loc: "",
        Pin: 0,
        Stcd: "00",
      };
    }
    const addr = await this.loadAddressDetails(reg.gstin, tenantId);
    return {
      Gstin: reg.gstin,
      LglNm: reg.legal_name,
      TrdNm: reg.trade_name ?? undefined,
      Pos: reg.state_code,
      Addr1: addr.addr1,
      Loc: addr.loc || stateMap.get(reg.state_code)?.state_name || "",
      Pin: addr.pin,
      Stcd: reg.state_code,
    };
  }

  /**
   * Converts tax_entries (multiple rows per component) into INV-01 ItemList
   * and aggregated ValDtls.
   *
   * Strategy: Group by hsn_sac_code. Each unique HSN becomes one line item.
   * Tax components (IGST, CGST, SGST, CESS) are summed per HSN.
   */
  private buildItemListAndValue(taxEntries: TaxEntryRow[]): {
    items: Inv01ItemDetail[];
    valDtls: Inv01InvoiceValue;
  } {
    // Group by HSN code
    const grouped = new Map<string, TaxEntryRow[]>();
    for (const te of taxEntries) {
      const key = te.hsn_sac_code ?? "999999";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(te);
    }

    const items: Inv01ItemDetail[] = [];
    let slNo = 0;
    let totalAssVal = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    let totalCess = 0;

    for (const [hsnCode, entries] of grouped) {
      slNo++;

      // Get the unique taxable_value (should be same across components for the same HSN)
      const firstEntry = entries[0];
      const assAmt = Number(firstEntry.taxable_value);

      // Sum each component
      const sum = (component: string) =>
        entries
          .filter((e) => e.component === component)
          .reduce((s, e) => s + Number(e.tax_amount), 0);

      const cgstAmt = this.round(sum("CGST"));
      const sgstAmt = this.round(sum("SGST") + sum("UTGST"));
      const igstAmt = this.round(sum("IGST"));
      const cessAmt = this.round(sum("CESS"));
      const gstRate = firstEntry.hsn_sac_code
        ? Number(firstEntry.tax_rate)
        : Number(firstEntry.tax_rate) * 2; // if half-rate stored

      const totItemVal = this.round(assAmt + cgstAmt + sgstAmt + igstAmt + cessAmt);

      items.push({
        SlNo: String(slNo),
        PrdDesc: firstEntry.narration ?? firstEntry.hsn_sac_code ?? "",
        IsServc: firstEntry.hsn_sac_code &&
          firstEntry.hsn_sac_code.startsWith("99") ? "Y" : "N",
        HsnCd: hsnCode,
        Qty: 1, // plug from your inventory if available
        Unit: "NOS",
        UnitPrice: assAmt,
        TotAmt: assAmt,
        Discount: 0,
        PreTaxVal: assAmt,
        AssAmt: assAmt,
        GstRt: gstRate,
        IgstAmt: igstAmt,
        CgstAmt: cgstAmt,
        SgstAmt: sgstAmt,
        CesRt: 0,
        CesAmt: cessAmt,
        CesNonAdvlAmt: 0,
        StateCesRt: 0,
        StateCesAmt: 0,
        StateCesNonAdvlAmt: 0,
        OthChrg: 0,
        TotItemVal: totItemVal,
      });

      totalAssVal = this.round(totalAssVal + assAmt);
      totalCgst = this.round(totalCgst + cgstAmt);
      totalSgst = this.round(totalSgst + sgstAmt);
      totalIgst = this.round(totalIgst + igstAmt);
      totalCess = this.round(totalCess + cessAmt);
    }

    const totInvVal = this.round(
      totalAssVal + totalCgst + totalSgst + totalIgst + totalCess
    );

    const valDtls: Inv01InvoiceValue = {
      AssVal: totalAssVal,
      CgstVal: totalCgst,
      SgstVal: totalSgst,
      IgstVal: totalIgst,
      CesVal: totalCess,
      StCesVal: 0,
      Discount: 0,
      OthChrg: 0,
      RndOffAmt: this.round(
        totInvVal -
          (totalAssVal + totalCgst + totalSgst + totalIgst + totalCess)
      ),
      TotInvVal: totInvVal,
      TotInvValFc: totInvVal, // assuming INR
    };

    return { items, valDtls };
  }

  private buildEwayBillItems(
    taxEntries: TaxEntryRow[]
  ): EwayBillPayload["itemList"] {
    const grouped = new Map<string, TaxEntryRow[]>();
    for (const te of taxEntries) {
      const key = te.hsn_sac_code ?? "999999";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(te);
    }

    const items: EwayBillPayload["itemList"] = [];
    let itemNo = 0;
    for (const [hsnCode, entries] of grouped) {
      itemNo++;
      const fe = entries[0];
      const assAmt = Number(fe.taxable_value);
      const sum = (c: string) =>
        entries.filter((e) => e.component === c).reduce((s, e) => s + Number(e.tax_amount), 0);

      items.push({
        itemNo,
        productName: fe.narration ?? hsnCode,
        productDesc: fe.narration ?? "",
        hsnCode,
        quantity: 1,
        qtyUnit: "NOS",
        taxableAmount: assAmt,
        taxRate: Number(fe.tax_rate),
        igstAmount: this.round(sum("IGST")),
        cgstAmount: this.round(sum("CGST")),
        sgstAmount: this.round(sum("SGST") + sum("UTGST")),
        cessAmount: this.round(sum("CESS")),
      });
    }
    return items;
  }

  private aggregateTaxSummary(taxEntries: TaxEntryRow[]) {
    const sum = (c: string) =>
      this.round(
        taxEntries
          .filter((e) => e.component === c)
          .reduce((s, e) => s + Number(e.tax_amount), 0)
      );
    const assVal = this.round(
      [...new Set(taxEntries.map((e) => e.taxable_value))]
        .reduce((s, v) => s + Number(v), 0)
    );
    return {
      assessableValue: assVal,
      cgst: sum("CGST"),
      sgst: sum("SGST") + sum("UTGST"),
      igst: sum("IGST"),
      cess: sum("CESS"),
    };
  }

  private formatDateDDMMYYYY(isoDate: string): string {
    const d = new Date(isoDate);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  private round(val: number): number {
    return Math.round(val * 100) / 100;
  }
}

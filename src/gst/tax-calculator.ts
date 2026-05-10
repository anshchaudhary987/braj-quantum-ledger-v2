import { PoolClient } from "pg";
import {
  TaxCalculationInput,
  TaxCalculationResult,
  TaxComponent,
  TaxEntryRow,
  HsnSacRow,
  GstRegistrationRow,
  StateMasterRow,
} from "./gst-types";
import { validateGstin, validatePlaceOfSupply } from "./gst-validator.js";

// ---------------------------------------------------------------------------
// AUTO-TAX CALCULATOR SERVICE
// ---------------------------------------------------------------------------

export class TaxCalculator {
  private stateCache: Map<string, StateMasterRow> | null = null;

  constructor(private readonly client: PoolClient) {}

  /**
   * MAIN ENTRY POINT
   *
   * Given an accounting transaction + HSN/SAC code + place of supply,
   * this method:
   *  1. Validates all GSTINs
   *  2. Looks up the tax rate from hsn_sac_master
   *  3. Compares company_state_code vs place_of_supply_code
   *  4. Splits into CGST+SGST (intrastate) or IGST (interstate)
   *  5. Handles UTGST for Union Territories without legislature
   *  6. Adds Cess if applicable
   *  7. Flags RCM transactions
   */
  async calculate(input: TaxCalculationInput): Promise<TaxCalculationResult> {
    // ---------- Step 1: Validate GSTINs ----------
    const companyValidation = validateGstin(input.company_gstin);
    if (!companyValidation.isValid) {
      throw new Error(`Invalid company GSTIN: ${companyValidation.errorMessage}`);
    }

    if (input.counterparty_gstin) {
      const cpValidation = validateGstin(input.counterparty_gstin);
      if (!cpValidation.isValid) {
        throw new Error(`Invalid counterparty GSTIN: ${cpValidation.errorMessage}`);
      }
    }

    // ---------- Step 2: Validate place of supply ----------
    const posValidation = validatePlaceOfSupply(
      input.place_of_supply_state_code,
      input.counterparty_gstin
    );
    if (!posValidation.isValid) {
      throw new Error(`Invalid place of supply: ${posValidation.warning}`);
    }
    // posValidation.warning may contain a non-blocking warning — log it

    // ---------- Step 3: Look up tax rate ----------
    const { rows: hsnRows } = await this.client.query<HsnSacRow>(
      `SELECT * FROM hsn_sac_master
       WHERE code = $1
         AND is_active = TRUE
         AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       LIMIT 1`,
      [input.hsn_sac_code]
    );

    if (hsnRows.length === 0) {
      throw new Error(`No active tax rate found for HSN/SAC: ${input.hsn_sac_code}`);
    }

    const hsn = hsnRows[0];
    const igstRate = Number(hsn.igst_rate);
    const cessRate = Number(hsn.cess_rate);

    // ---------- Step 4: Load state master ----------
    const stateMaster = await this.loadStateMaster();

    // ---------- Step 5: Determine intra vs inter state ----------
    const companyState = companyValidation.stateCode!;
    const posState     = input.place_of_supply_state_code;
    const isInterstate = companyState !== posState;

    // ---------- Step 6: Check RCM ----------
    let isRcm = input.is_rcm_applicable ?? false;

    // Auto-detect RCM: if counterparty is URD (Unregistered Dealer)
    // and taxable_value exceeds the threshold (₹5000/day for goods)
    if (!isRcm && input.tax_type === "INPUT" && !input.counterparty_gstin) {
      if (input.taxable_value > 5000) {
        isRcm = true;
      }
    }

    // Also auto-detect RCM for Composition dealers
    if (!isRcm && input.tax_type === "INPUT" && input.counterparty_gstin) {
      const { rows: cpRows } = await this.client.query<GstRegistrationRow>(
        `SELECT registration_type FROM gst_registrations WHERE gstin = $1`,
        [input.counterparty_gstin]
      );
      if (cpRows[0]?.registration_type === "COMPOSITION") {
        isRcm = true;
      }
    }

    // ---------- Step 7: Generate tax components ----------
    const components = this.buildComponents(
      companyState,
      posState,
      isInterstate,
      igstRate,
      cessRate,
      input.taxable_value,
      stateMaster
    );

    const totalTax = components.reduce((sum, c) => sum + c.tax_amount, 0);

    const posStateInfo = stateMaster.get(posState);
    const isUtgstApplicable =
      posStateInfo?.region_type === "UNION_TERRITORY" &&
      !posStateInfo.has_own_legislature &&
      !isInterstate;

    return {
      tax_type: input.tax_type,
      taxable_value: input.taxable_value,
      hsn_sac_code: input.hsn_sac_code,
      igst_rate: igstRate,
      cess_rate: cessRate,
      is_interstate: isInterstate,
      place_of_supply_state: posState,
      company_state: companyState,
      components,
      total_tax: Math.round(totalTax * 100) / 100,
      total_invoice_value: Math.round((input.taxable_value + totalTax) * 100) / 100,
      is_rcm: isRcm,
      is_utgst_applicable: isUtgstApplicable,
    };
  }

  /**
   * Persist the calculated tax components as tax_entries rows.
   * Called AFTER the journal_entries are committed.
   */
  async persistTaxEntries(
    result: TaxCalculationResult,
    transactionId: number,
    journalEntryIds: number[],
    counterpartyGstin?: string,
    returnPeriod?: string
  ): Promise<void> {
    // Map each tax component to a tax_entries row
    for (const comp of result.components) {
      // Each component maps to a journal entry line (for simplicity: take the first line)
      await this.client.query(
        `INSERT INTO tax_entries (
           transaction_id, journal_entry_id, counterparty_gstin,
           tax_type, component,
           hsn_sac_code, taxable_value, tax_rate, tax_amount,
           place_of_supply_state_code,
           is_rcm, return_period, narration
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          transactionId,
          journalEntryIds[0], // principal journal line
          counterpartyGstin ?? null,
          result.tax_type,
          comp.component,
          result.hsn_sac_code,
          result.taxable_value,
          comp.tax_rate,
          comp.tax_amount,
          result.place_of_supply_state,
          result.is_rcm,
          returnPeriod ?? null,
          result.is_rcm ? `RCM applied: ${result.tax_type === "INPUT" ? "Recipient liable" : "Not applicable"}` : null,
        ]
      );
    }
  }

  /**
   * Returns aggregated tax liability for GSTR-1 / GSTR-3B filing.
   */
  async getTaxLiability(
    returnPeriod: string,
    registrationGstin: string
  ): Promise<{
    period: string;
    summary: Array<{
      tax_type: string;
      component: string;
      taxable_value: number;
      tax_amount: number;
      count: number;
    }>;
    rcm_summary: Array<{
      tax_type: string;
      component: string;
      taxable_value: number;
      tax_amount: number;
    }>;
  }> {
    const { rows } = await this.client.query<{
      tax_type: string;
      component: string;
      taxable_value: string;
      tax_amount: string;
      count: string;
    }>(
      `SELECT tax_type, component,
              SUM(taxable_value) AS taxable_value,
              SUM(tax_amount)    AS tax_amount,
              COUNT(*)::TEXT     AS count
       FROM tax_entries
       WHERE return_period = $1
       GROUP BY tax_type, component`,
      [returnPeriod]
    );

    const summary = rows.map((r) => ({
      tax_type: r.tax_type,
      component: r.component,
      taxable_value: Number(r.taxable_value),
      tax_amount: Number(r.tax_amount),
      count: Number(r.count),
    }));

    // RCM-specific aggregation
    const { rows: rcmRows } = await this.client.query<{
      tax_type: string;
      component: string;
      taxable_value: string;
      tax_amount: string;
    }>(
      `SELECT tax_type, component,
              SUM(taxable_value) AS taxable_value,
              SUM(tax_amount)    AS tax_amount
       FROM tax_entries
       WHERE return_period = $1 AND is_rcm = TRUE
       GROUP BY tax_type, component`,
      [returnPeriod]
    );

    const rcmSummary = rcmRows.map((r) => ({
      tax_type: r.tax_type,
      component: r.component,
      taxable_value: Number(r.taxable_value),
      tax_amount: Number(r.tax_amount),
    }));

    return { period: returnPeriod, summary, rcm_summary: rcmSummary };
  }

  // -----------------------------------------------------------------------
  // PRIVATE HELPERS
  // -----------------------------------------------------------------------

  private buildComponents(
    companyState: string,
    posState: string,
    isInterstate: boolean,
    igstRate: number,
    cessRate: number,
    taxableValue: number,
    stateMaster: Map<string, StateMasterRow>
  ): TaxComponent[] {
    const components: TaxComponent[] = [];

    if (isInterstate) {
      // ── INTERSTATE → IGST ──
      components.push({
        component: "IGST",
        tax_rate: igstRate,
        tax_amount: this.round(taxableValue * igstRate / 100),
      });
    } else {
      // ── INTRASTATE → CGST + (SGST or UTGST) ──
      const halfRate = igstRate / 2;

      if (this.isUtWithoutLegislature(posState, stateMaster)) {
        // UT without legislature → UTGST
        components.push(
          { component: "CGST",  tax_rate: halfRate, tax_amount: this.round(taxableValue * halfRate / 100) },
          { component: "UTGST", tax_rate: halfRate, tax_amount: this.round(taxableValue * halfRate / 100) },
        );
      } else {
        // State or UT with legislature → SGST
        components.push(
          { component: "CGST", tax_rate: halfRate, tax_amount: this.round(taxableValue * halfRate / 100) },
          { component: "SGST", tax_rate: halfRate, tax_amount: this.round(taxableValue * halfRate / 100) },
        );
      }
    }

    // Cess (on top, always central component)
    if (cessRate > 0) {
      components.push({
        component: "CESS",
        tax_rate: cessRate,
        tax_amount: this.round(taxableValue * cessRate / 100),
      });
    }

    return components;
  }

  private isUtWithoutLegislature(
    stateCode: string,
    stateMaster: Map<string, StateMasterRow>
  ): boolean {
    const state = stateMaster.get(stateCode);
    if (!state) return false;
    return state.region_type === "UNION_TERRITORY" && !state.has_own_legislature;
  }

  private async loadStateMaster(): Promise<Map<string, StateMasterRow>> {
    if (this.stateCache) return this.stateCache;

    const { rows } = await this.client.query<StateMasterRow>(
      `SELECT state_code, state_name, region_type, has_own_legislature
       FROM state_master WHERE is_active = TRUE`
    );

    this.stateCache = new Map();
    for (const row of rows) {
      this.stateCache.set(row.state_code, row);
    }
    return this.stateCache;
  }

  private round(amount: number): number {
    return Math.round(amount * 100) / 100;
  }
}

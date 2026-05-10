// ============================================================================
// ANALYTICS SERVICE — Wraps PostgreSQL analytics functions
// ============================================================================

import { PoolClient } from "pg";
import {
  CashFlowLine,
  CashFlowReport,
  CashFlowSectionSummary,
  FinancialRatio,
  RatioReport,
  InventoryAgingLine,
  InventoryAgingSummary,
  InventoryAgingReport,
  ExecutiveDashboard,
  DashboardKeyMetrics,
  AccountClassification,
} from "./analytics-types";

export class AnalyticsService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // CASH FLOW STATEMENT
  // -----------------------------------------------------------------------

  async getCashFlow(
    tenantId: string,
    fromDate: string,
    toDate: string
  ): Promise<CashFlowReport> {
    const { rows } = await this.client.query<CashFlowLine>(
      `SELECT section, line_item, amount, sort_order
       FROM generate_cash_flow_statement($1::UUID, $2::DATE, $3::DATE)`,
      [tenantId, fromDate, toDate]
    );

    const lines = rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      sort_order: Number(r.sort_order),
    }));

    const operatingTotal =
      lines.find((l) => l.line_item === "Net Cash from Operating Activities")?.amount ?? 0;
    const investingTotal =
      lines.find((l) => l.line_item === "Net Cash from Investing Activities")?.amount ?? 0;
    const financingTotal =
      lines.find((l) => l.line_item === "Net Cash from Financing Activities")?.amount ?? 0;
    const netCashChange =
      lines.find((l) => l.line_item === "Net Increase/(Decrease) in Cash")?.amount ?? 0;
    const variance = lines.find((l) => l.line_item === "Variance")?.amount ?? 0;

    return {
      from_date: fromDate,
      to_date: toDate,
      lines,
      operating_total: operatingTotal,
      investing_total: investingTotal,
      financing_total: financingTotal,
      net_cash_change: netCashChange,
      variance,
    };
  }

  /**
   * Returns section-level summaries only (for dashboard tiles).
   */
  async getCashFlowSummary(
    tenantId: string,
    fromDate: string,
    toDate: string
  ): Promise<CashFlowSectionSummary[]> {
    const report = await this.getCashFlow(tenantId, fromDate, toDate);

    const sections = new Map<string, CashFlowSectionSummary>();
    for (const line of report.lines) {
      if (line.section === "RECONCILIATION") continue;
      if (line.line_item.startsWith("Net Cash")) {
        sections.set(line.section.toLowerCase(), {
          section: line.section,
          amount: line.amount,
        });
      }
    }

    return [
      sections.get("operating") ?? { section: "OPERATING", amount: report.operating_total },
      sections.get("investing") ?? { section: "INVESTING", amount: report.investing_total },
      sections.get("financing") ?? { section: "FINANCING", amount: report.financing_total },
    ];
  }

  // -----------------------------------------------------------------------
  // FINANCIAL RATIOS
  // -----------------------------------------------------------------------

  async getRatios(
    tenantId: string,
    asOfDate: string
  ): Promise<RatioReport> {
    const { rows } = await this.client.query<FinancialRatio>(
      `SELECT ratio_name, ratio_value, numerator, denominator, formula, health
       FROM calculate_financial_ratios($1::UUID, $2::DATE)`,
      [tenantId, asOfDate]
    );

    return {
      as_of_date: asOfDate,
      ratios: rows.map((r) => ({
        ...r,
        ratio_value: r.ratio_value !== null ? Number(r.ratio_value) : null,
        numerator: Number(r.numerator),
        denominator: Number(r.denominator),
      })),
    };
  }

  /**
   * Fast-path: read from materialized view (must be refreshed via analytics_refresh_ratios()).
   */
  async getRatiosMaterialised(asOfDate: string): Promise<RatioReport> {
    const { rows } = await this.client.query<FinancialRatio>(
      `SELECT ratio_name, ratio_value, numerator, denominator, formula, health
       FROM mv_dashboard_ratios
       WHERE as_of_date = $1::DATE`,
      [asOfDate]
    );

    return {
      as_of_date: asOfDate,
      ratios: rows.map((r) => ({
        ...r,
        ratio_value: r.ratio_value !== null ? Number(r.ratio_value) : null,
        numerator: Number(r.numerator),
        denominator: Number(r.denominator),
      })),
    };
  }

  // -----------------------------------------------------------------------
  // INVENTORY AGING
  // -----------------------------------------------------------------------

  async getInventoryAging(tenantId: string): Promise<InventoryAgingReport> {
    const [detailResult, summaryResult] = await Promise.all([
      this.client.query<InventoryAgingLine>(
        `SELECT stock_item_id, item_name, batch_number, aging_bucket,
                total_qty, total_value, days_old_min, days_old_max
         FROM generate_inventory_aging($1::UUID)`,
        [tenantId]
      ),
      this.client.query<InventoryAgingSummary>(
        `SELECT aging_bucket, qty_on_hand, value_at_risk, item_count
         FROM generate_inventory_aging_summary($1::UUID)`,
        [tenantId]
      ),
    ]);

    const asOfDate = new Date().toISOString().split("T")[0];

    return {
      as_of_date: asOfDate,
      details: detailResult.rows.map((r) => ({
        ...r,
        total_qty: Number(r.total_qty),
        total_value: Number(r.total_value),
        days_old_min: Number(r.days_old_min),
        days_old_max: Number(r.days_old_max),
        item_count: undefined as unknown as number, // not in detail result
      })),
      summary: summaryResult.rows.map((r) => ({
        ...r,
        qty_on_hand: Number(r.qty_on_hand),
        value_at_risk: Number(r.value_at_risk),
        item_count: Number(r.item_count),
      })),
    };
  }

  /**
   * Fast-path: inventory summary from materialized view.
   */
  async getInventoryAgingSummaryMaterialised(): Promise<InventoryAgingSummary[]> {
    const { rows } = await this.client.query<InventoryAgingSummary>(
      `SELECT aging_bucket, qty_on_hand, value_at_risk, item_count
       FROM mv_inventory_aging_summary`
    );

    return rows.map((r) => ({
      ...r,
      qty_on_hand: Number(r.qty_on_hand),
      value_at_risk: Number(r.value_at_risk),
      item_count: Number(r.item_count),
    }));
  }

  // -----------------------------------------------------------------------
  // EXECUTIVE DASHBOARD — Composite endpoint
  // -----------------------------------------------------------------------

  async getExecutiveDashboard(
    tenantId: string,
    asOfDate?: string
  ): Promise<ExecutiveDashboard> {
    const date = asOfDate ?? new Date().toISOString().split("T")[0];

    // Compute FY start for P&L window
    const fyStart = this.getFinancialYearStart(date);
    const fromDate = fyStart;                        // P&L from FY start
    const cfFromDate = this.addMonths(date, -1);     // Cash flow: last 1 month

    const [ratios, inventory, cashFlowSummary] = await Promise.all([
      this.getRatios(tenantId, date),
      this.getInventoryAgingSummaryMaterialised(),
      this.getCashFlowSummary(tenantId, cfFromDate, date),
    ]);

    const revenue = this.findRatioValue(ratios.ratios, "Net Profit Margin")
      ? this.findRatio(ratios.ratios, "Net Profit Margin")?.denominator ?? 0
      : 0;
    const netIncome = this.findRatioValue(ratios.ratios, "Net Profit Margin")
      ? this.findRatio(ratios.ratios, "Net Profit Margin")?.numerator ?? 0
      : 0;

    const keyMetrics: DashboardKeyMetrics = {
      revenue,
      net_income: netIncome,
      current_ratio: this.findRatioValue(ratios.ratios, "Current Ratio"),
      debt_to_equity: this.findRatioValue(ratios.ratios, "Debt-to-Equity"),
      net_profit_margin: this.findRatioValue(ratios.ratios, "Net Profit Margin"),
      cash_balance: 0,   // populated below if available
      inventory_value: inventory.reduce((sum, b) => sum + b.value_at_risk, 0),
      receivables_ageing: [],
    };

    return {
      as_of_date: date,
      ratios: ratios.ratios,
      inventory_aging_summary: inventory,
      cash_flow_summary: cashFlowSummary,
      key_metrics: keyMetrics,
    };
  }

  /**
   * Fast-path: use the get_executive_dashboard SQL function that returns JSONB.
   */
  async getExecutiveDashboardFast(tenantId: string, asOfDate?: string): Promise<ExecutiveDashboard> {
    const date = asOfDate ?? new Date().toISOString().split("T")[0];
    const { rows } = await this.client.query<{ result: ExecutiveDashboard }>(
      `SELECT get_executive_dashboard($1::UUID, $2::DATE) AS result`,
      [tenantId, date]
    );
    return rows[0].result;
  }

  // -----------------------------------------------------------------------
  // MATERIALIZED VIEW REFRESH — Called after relevant mutations
  // -----------------------------------------------------------------------

  async refreshMaterializedRatios(): Promise<void> {
    await this.client.query("SELECT analytics_refresh_ratios()");
  }

  async refreshMaterializedInventoryAging(): Promise<void> {
    await this.client.query("SELECT analytics_refresh_inventory_aging()");
  }

  async refreshAllMaterialized(): Promise<void> {
    await this.client.query("SELECT analytics_refresh_all()");
  }

  // -----------------------------------------------------------------------
  // ACCOUNT CLASSIFICATION — Returns classification for given accounts
  // -----------------------------------------------------------------------

  async getAccountClassifications(
    accountIds: number[]
  ): Promise<AccountClassification[]> {
    if (accountIds.length === 0) return [];

    const { rows } = await this.client.query<AccountClassification>(
      `SELECT account_id, account_name, account_type,
              cash_flow_section, account_sub_type, is_cash_account
       FROM accounts
       WHERE account_id = ANY($1::BIGINT[])`,
      [accountIds]
    );

    return rows;
  }

  // -----------------------------------------------------------------------
  // HELPERS
  // -----------------------------------------------------------------------

  private findRatio(ratios: FinancialRatio[], name: string): FinancialRatio | undefined {
    return ratios.find((r) => r.ratio_name === name);
  }

  private findRatioValue(ratios: FinancialRatio[], name: string): number | null {
    return this.findRatio(ratios, name)?.ratio_value ?? null;
  }

  private getFinancialYearStart(date: string): string {
    const d = new Date(date);
    const month = d.getMonth() + 1; // 1-indexed
    const year = d.getFullYear();
    if (month >= 4) {
      return `${year}-04-01`;
    }
    return `${year - 1}-04-01`;
  }

  private addMonths(date: string, months: number): string {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d.toISOString().split("T")[0];
  }
}
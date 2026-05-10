// ============================================================================
// DEPRECIATION SERVICE — Auto-depreciation engine (IT Act + Companies Act)
// ============================================================================
// Logic: Calls the PostgreSQL stored procedure `post_annual_depreciation()`
// which handles WDV (Income Tax Act) and SLM (Companies Act) methods.
// ============================================================================

import { PoolClient } from "pg";
import { AssetBlock, FixedAsset, DepreciationRun, DepreciationRunItem, CreateAssetInput } from "./depreciation-types.js";

export class DepreciationService {
  constructor(private readonly client: PoolClient) {}

  // -------------------------------------------------------------------
  // POST ANNUAL DEPRECIATION (calls stored procedure)
  // -------------------------------------------------------------------

  /**
   * Posts depreciation for ALL active assets in the given financial year.
   * This is the core year-end engine — run on 31st March (or any FY-end date).
   *
   * @param companyId     — Tenant company
   * @param financialYear — Starting year (e.g., 2025 for FY 2025-2026)
   * @param actType       — 'INCOME_TAX' (WDV block method) or 'COMPANIES_ACT' (SLM/WDV)
   * @param postedBy      — User ID executing this (0 = SYSTEM for automated cron)
   * @returns The depr_run_id of the newly created depreciation run
   */
  async postAnnualDepreciation(
    companyId: number,
    financialYear: number,
    actType: "INCOME_TAX" | "COMPANIES_ACT",
    postedBy: number = 0
  ): Promise<number> {
    const { rows } = await this.client.query<{ depr_run_id: number }>(
      `SELECT post_annual_depreciation($1, $2, $3, $4) AS depr_run_id`,
      [companyId, financialYear, actType, postedBy]
    );
    return rows[0].depr_run_id;
  }

  /**
   * Posts both IT Act and Companies Act depreciation in a single call.
   * Typically done at year-end (31st March).
   */
  async postAllDepreciation(
    companyId: number,
    financialYear: number
  ): Promise<{ it_run_id: number; ca_run_id: number }> {
    const [itRow, caRow] = await Promise.all([
      this.client.query<{ depr_run_id: number }>(
        `SELECT post_annual_depreciation($1, $2, 'INCOME_TAX', 0) AS depr_run_id`,
        [companyId, financialYear]
      ),
      this.client.query<{ depr_run_id: number }>(
        `SELECT post_annual_depreciation($1, $2, 'COMPANIES_ACT', 0) AS depr_run_id`,
        [companyId, financialYear]
      ),
    ]);

    return {
      it_run_id: itRow.rows[0].depr_run_id,
      ca_run_id: caRow.rows[0].depr_run_id,
    };
  }

  // -------------------------------------------------------------------
  // ASSET BLOCKS
  // -------------------------------------------------------------------

  async createAssetBlock(block: Omit<AssetBlock, "asset_block_id">): Promise<AssetBlock> {
    const { rows } = await this.client.query<AssetBlock>(
      `INSERT INTO asset_blocks (company_id, block_name, depreciation_rate, companies_act_rate, useful_life_years, residual_value_pct)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [block.company_id, block.block_name, block.depreciation_rate, block.companies_act_rate ?? null, block.useful_life_years ?? null, block.residual_value_pct ?? 5.00]
    );
    return rows[0];
  }

  async getAssetBlocks(companyId: number): Promise<AssetBlock[]> {
    const { rows } = await this.client.query<AssetBlock>(
      `SELECT * FROM asset_blocks WHERE company_id = $1 ORDER BY block_name`,
      [companyId]
    );
    return rows;
  }

  // -------------------------------------------------------------------
  // FIXED ASSETS
  // -------------------------------------------------------------------

  async createAsset(input: CreateAssetInput): Promise<FixedAsset> {
    const { rows } = await this.client.query<FixedAsset>(
      `INSERT INTO fixed_assets
         (company_id, asset_block_id, asset_code, asset_name, serial_number,
          purchase_date, purchase_value, residual_value,
          slm_rate, asset_gl_account_id, accumulated_depr_gl_id, depreciation_expense_gl_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.company_id, input.asset_block_id, input.asset_code, input.asset_name,
        input.serial_number ?? null, input.purchase_date, input.purchase_value,
        input.residual_value ?? 0, input.slm_rate ?? null,
        input.asset_gl_account_id, input.accumulated_depr_gl_id, input.depreciation_expense_gl_id,
      ]
    );
    return rows[0];
  }

  async getAssets(companyId: number, status?: string): Promise<FixedAsset[]> {
    const { rows } = await this.client.query<FixedAsset>(
      `SELECT * FROM fixed_assets WHERE company_id = $1 ${status ? "AND status = $2" : ""} ORDER BY asset_code`,
      status ? [companyId, status] : [companyId]
    );
    return rows;
  }

  async getAssetsForDepreciation(companyId: number, financialYear: number): Promise<FixedAsset[]> {
    // Assets purchased on or before 31st March of the FY end
    const fyEnd = `${financialYear + 1}-03-31`;
    const { rows } = await this.client.query<FixedAsset>(
      `SELECT fa.*
       FROM fixed_assets fa
       WHERE fa.company_id = $1
         AND fa.status = 'ACTIVE'
         AND fa.purchase_date <= $2::DATE
         AND fa.wdv_as_on > 0    -- Not fully depreciated
       ORDER BY fa.asset_block_id, fa.asset_code`,
      [companyId, fyEnd]
    );
    return rows;
  }

  // -------------------------------------------------------------------
  // DEPRECIATION RUN HISTORY
  // -------------------------------------------------------------------

  async getDepreciationRun(runId: number): Promise<DepreciationRun | null> {
    const { rows } = await this.client.query<DepreciationRun>(
      `SELECT * FROM depreciation_runs WHERE depr_run_id = $1`,
      [runId]
    );
    return rows[0] ?? null;
  }

  async getDepreciationRunItems(runId: number): Promise<DepreciationRunItem[]> {
    const { rows } = await this.client.query<DepreciationRunItem>(
      `SELECT dri.*, fa.asset_name
       FROM depreciation_run_items dri
       JOIN fixed_assets fa ON fa.asset_id = dri.asset_id
       WHERE dri.depr_run_id = $1
       ORDER BY fa.asset_code`,
      [runId]
    );
    return rows;
  }

  async getRunsForCompany(companyId: number): Promise<DepreciationRun[]> {
    const { rows } = await this.client.query<DepreciationRun>(
      `SELECT * FROM depreciation_runs WHERE company_id = $1 ORDER BY financial_year DESC, act_type`,
      [companyId]
    );
    return rows;
  }

  // -------------------------------------------------------------------
  // SUMMARY — Asset Schedule for CA / Audit
  // -------------------------------------------------------------------

  async getAssetSchedule(companyId: number): Promise<{
    blocks: (AssetBlock & { assets: FixedAsset[]; block_wdv: number })[];
    total_gross: number;
    total_depr: number;
    total_net:   number;
  }> {
    const blocks = await this.getAssetBlocks(companyId);
    const assets = await this.getAssets(companyId, "ACTIVE");

    let totalGross = 0;
    let totalDepr = 0;

    const blockSchedule = blocks.map((block) => {
      const blockAssets = assets.filter((a) => a.asset_block_id === block.asset_block_id);
      const blockGross = blockAssets.reduce((s, a) => s + a.purchase_value, 0);
      const blockDepr = blockAssets.reduce((s, a) => s + a.accumulated_depr, 0);

      totalGross += blockGross;
      totalDepr += blockDepr;

      return {
        ...block,
        assets: blockAssets,
        block_wdv: blockGross - blockDepr,
      };
    });

    return {
      blocks: blockSchedule,
      total_gross: totalGross,
      total_depr: totalDepr,
      total_net: totalGross - totalDepr,
    };
  }
}

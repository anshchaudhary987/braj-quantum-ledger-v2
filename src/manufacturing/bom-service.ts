import { PoolClient } from "pg";
import { CreateBomInput, BomRow, BomItemRow } from "./manufacturing-types.js";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// BOM SERVICE — Manage Bills of Materials
// ---------------------------------------------------------------------------

export class BomService {
  constructor(private readonly client: PoolClient) {}

  async createBom(input: CreateBomInput, companyId: number): Promise<number> {
    const { rows } = await this.client.query<BomRow>(
      `INSERT INTO boms
         (company_id, bom_name, bom_code, finished_good_item_id,
          base_output_quantity, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING bom_id`,
      [companyId, input.bom_name, input.bom_code ?? null,
       input.finished_good_item_id,
       input.base_output_quantity ?? 1,
       input.effective_from ?? new Date().toISOString().split("T")[0]]
    );

    const bomId = rows[0].bom_id;

    for (const item of input.items) {
      await this.client.query(
        `INSERT INTO bom_items
           (bom_id, stock_item_id, item_type, required_quantity, uom_id,
            scrap_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [bomId, item.stock_item_id, item.item_type,
         item.required_quantity, item.uom_id,
         item.scrap_percentage ?? 0, item.sort_order ?? 0]
      );
    }

    return bomId;
  }

  async getBomWithItems(bomId: number): Promise<{ bom: BomRow; items: BomItemRow[] }> {
    const { rows: bomRows } = await this.client.query<BomRow>(
      `SELECT * FROM boms WHERE bom_id = $1`, [bomId]
    );
    if (bomRows.length === 0) throw new AppError(ErrorCode.NOT_FOUND, "BOM not found.");

    const { rows: itemRows } = await this.client.query<BomItemRow>(
      `SELECT * FROM bom_items WHERE bom_id = $1 ORDER BY sort_order`, [bomId]
    );

    return { bom: bomRows[0], items: itemRows };
  }

  async listBoms(companyId: number, finishedGoodItemId?: number): Promise<BomRow[]> {
    const { rows } = await this.client.query<BomRow>(
      `SELECT * FROM boms
       WHERE company_id = $1
         AND (finished_good_item_id = $2 OR $2 IS NULL)
         AND is_active = TRUE
       ORDER BY bom_name`,
      [companyId, finishedGoodItemId ?? null]
    );
    return rows;
  }
}

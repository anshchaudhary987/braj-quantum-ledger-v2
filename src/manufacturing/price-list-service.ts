import { PoolClient } from "pg";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// PRICE LIST SERVICE — Customer-specific, slab-based, date-ranged pricing
// ---------------------------------------------------------------------------

export interface PriceLevelRow {
  price_level_id: number;
  level_name: string;
  is_default: boolean;
}

export interface PriceListItemRow {
  price_list_item_id: number;
  stock_item_id: number;
  price_level_id: number;
  uom_id: number;
  rate: string;
  min_quantity: string | null;
  max_quantity: string | null;
  applicable_from: string | null;
  applicable_to: string | null;
  discount_percent: string | null;
  is_discount: boolean;
}

export interface SalesPriceLookupResult {
  rate: number;
  price_level_used: string;
  matched_by: "SLAB" | "LEVEL_ONLY" | "DEFAULT" | "NONE";
  applied_discount_percent?: number;
}

export class PriceListService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // PRICE LEVELS
  // -----------------------------------------------------------------------
  async createPriceLevel(
    levelName: string,
    isDefault: boolean,
    companyId: number
  ): Promise<number> {
    const { rows } = await this.client.query<PriceLevelRow>(
      `INSERT INTO price_levels (company_id, level_name, is_default)
       VALUES ($1, $2, $3)
       RETURNING price_level_id`,
      [companyId, levelName, isDefault]
    );
    return rows[0].price_level_id;
  }

  // -----------------------------------------------------------------------
  // PRICE LIST ITEMS
  // -----------------------------------------------------------------------
  async setPrice(
    input: {
      stock_item_id: number;
      price_level_id: number;
      uom_id: number;
      rate: number;
      min_quantity?: number;
      max_quantity?: number;
      applicable_from?: string;
      applicable_to?: string;
      discount_percent?: number;
      is_discount?: boolean;
    },
    companyId: number
  ): Promise<number> {
    const { rows } = await this.client.query<PriceListItemRow>(
      `INSERT INTO price_list_items
         (company_id, stock_item_id, price_level_id, uom_id, rate,
          min_quantity, max_quantity,
          applicable_from, applicable_to,
          discount_percent, is_discount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING price_list_item_id`,
      [companyId, input.stock_item_id, input.price_level_id, input.uom_id,
       input.rate,
       input.min_quantity ?? null, input.max_quantity ?? null,
       input.applicable_from ?? null, input.applicable_to ?? null,
       input.discount_percent ?? null, input.is_discount ?? false]
    );
    return rows[0].price_list_item_id;
  }

  // -----------------------------------------------------------------------
  // PRICE LOOKUP — The core auto-fetch logic for Sales Voucher
  // -----------------------------------------------------------------------

  /**
   * Resolves the correct sale price for a line item at the time of
   * voucher creation. Called by the Sales Voucher route handler.
   *
   * Priority:
   *   1. Customer's price level + quantity slab match + date range match
   *   2. Customer's price level without slab (any quantity)
   *   3. Company default price level + slab match
   *   4. Company default price level without slab
   *   5. No price found — returns rate=0 (caller should reject with error)
   */
  async lookupPrice(
    stockItemId: number,
    customerAccountId: number,
    quantity: number,
    voucherDate: string,
    companyId: number
  ): Promise<SalesPriceLookupResult> {
    // Use the SQL function for accuracy and performance (single round-trip)
    const { rows } = await this.client.query<{
      rate: string;
      price_level_used: string;
      matched_by: string;
    }>(
      `SELECT * FROM get_sales_price($1, $2, $3, $4, $5)`,
      [stockItemId, customerAccountId, quantity, voucherDate, companyId]
    );

    if (rows.length === 0 || rows[0].matched_by === "NONE") {
      return { rate: 0, price_level_used: "NONE", matched_by: "NONE" };
    }

    return {
      rate: Number(rows[0].rate),
      price_level_used: rows[0].price_level_used,
      matched_by: rows[0].matched_by as SalesPriceLookupResult["matched_by"],
    };
  }

  /**
   * Fetches ALL applicable prices for a stock item (across all levels).
   * Useful for showing the price matrix in the UI.
   */
  async getPriceMatrix(
    stockItemId: number,
    companyId: number,
    asOfDate?: string
  ): Promise<
    Array<{
      price_level_name: string;
      slab: { min: number | null; max: number | null };
      rate: number;
      applicable_from: string | null;
      applicable_to: string | null;
    }>
  > {
    const date = asOfDate ?? new Date().toISOString().split("T")[0];

    const { rows } = await this.client.query<{
      level_name: string;
      min_quantity: string | null;
      max_quantity: string | null;
      rate: string;
      applicable_from: string | null;
      applicable_to: string | null;
    }>(
      `SELECT pl.level_name,
              pli.min_quantity, pli.max_quantity,
              pli.rate,
              pli.applicable_from::TEXT, pli.applicable_to::TEXT
       FROM price_list_items pli
       JOIN price_levels pl ON pl.price_level_id = pli.price_level_id
       WHERE pli.stock_item_id = $1
         AND pli.company_id    = $2
         AND pli.is_active     = TRUE
         AND (pli.applicable_from IS NULL OR pli.applicable_from <= $3::DATE)
         AND (pli.applicable_to   IS NULL OR pli.applicable_to   >= $3::DATE)
       ORDER BY pl.level_name, pli.min_quantity NULLS FIRST`,
      [stockItemId, companyId, date]
    );

    return rows.map((r) => ({
      price_level_name: r.level_name,
      slab: {
        min: r.min_quantity ? Number(r.min_quantity) : null,
        max: r.max_quantity ? Number(r.max_quantity) : null,
      },
      rate: Number(r.rate),
      applicable_from: r.applicable_from,
      applicable_to: r.applicable_to,
    }));
  }

  /**
   * Assigns a price level to a customer account.
   */
  async setCustomerPriceLevel(
    accountId: number,
    priceLevelId: number
  ): Promise<void> {
    await this.client.query(
      `UPDATE accounts SET price_level_id = $1 WHERE account_id = $2`,
      [priceLevelId, accountId]
    );
  }
}

import { PoolClient } from "pg";
import { JournalLine, VoucherPayload } from "../models/types";
import { VoucherStrategy } from "./voucher-strategy";

export class SalesVoucherStrategy implements VoucherStrategy {
  readonly voucherType = "SALES_VOUCHER";

  async translate(
    client: PoolClient,
    payload: VoucherPayload,
    tenantId: string,
    _txnDate: string
  ): Promise<JournalLine[]> {
    const customerAccountId = Number(payload.customer_account_id);
    const taxableValue = Number(payload.taxable_value);
    const taxAmount = Number(payload.tax_amount ?? 0);
    const grandTotal = Number(payload.grand_total);

    if (!customerAccountId || taxableValue <= 0 || grandTotal <= 0) {
      throw new Error("SALES_VOUCHER requires customer_account_id, taxable_value > 0, and grand_total > 0");
    }

    const salesAccountId = await this.findAccount(
      client,
      tenantId,
      ["3100"],
      "Income",
      "sales revenue"
    );

    const lines: JournalLine[] = [
      {
        account_id: customerAccountId,
        debit_amount: grandTotal,
        credit_amount: 0,
        description: "Sales invoice receivable",
      },
      {
        account_id: salesAccountId,
        debit_amount: 0,
        credit_amount: taxableValue,
        description: "Sales revenue",
      },
    ];

    if (taxAmount > 0) {
      const taxPayableAccountId = await this.findAccount(
        client,
        tenantId,
        ["2115", "2116", "2117", "2100"],
        "Liability",
        "tax payable"
      );

      lines.push({
        account_id: taxPayableAccountId,
        debit_amount: 0,
        credit_amount: taxAmount,
        description: "Output GST payable",
      });
    }

    return lines;
  }

  private async findAccount(
    client: PoolClient,
    tenantId: string,
    preferredCodes: string[],
    accountType: string,
    label: string
  ): Promise<number> {
    const { rows } = await client.query<{ account_id: number }>(
      `SELECT account_id
       FROM accounts
       WHERE company_id = $1
         AND is_active = TRUE
         AND (account_code = ANY($2::text[]) OR account_type = $3)
       ORDER BY CASE WHEN account_code = ANY($2::text[]) THEN 0 ELSE 1 END,
                account_id
       LIMIT 1`,
      [Number(tenantId), preferredCodes, accountType]
    );

    const accountId = rows[0]?.account_id;
    if (!accountId) {
      throw new Error(`No ${label} account found for this company`);
    }
    return accountId;
  }
}

import { PoolClient } from "pg";
import { VoucherStrategy } from "./voucher-strategy.js";
import { JournalLine, VoucherPayload } from "../models/types.js";

/**
 * PAYMENT_VOUCHER
 * Business rule: Debit the Vendor/Payee account, Credit the Bank account.
 *
 * Expected payload:
 * {
 *   from_account_id: number,   // Bank account (credited)
 *   to_account_id:   number,   // Vendor / Expense account (debited)
 *   amount:          number,
 *   narration?:      string
 * }
 */
export class PaymentVoucherStrategy implements VoucherStrategy {
  readonly voucherType = "PAYMENT_VOUCHER";

  async translate(
    _client: PoolClient,
    payload: VoucherPayload,
    _tenantId: string,
    _txnDate: string
  ): Promise<JournalLine[]> {
    const fromAccount = Number(payload.from_account_id);
    const toAccount   = Number(payload.to_account_id);
    const amount      = Number(payload.amount);
    const narration   = String(payload.narration ?? "");

    if (!fromAccount || !toAccount || !amount || amount <= 0) {
      throw new Error("PAYMENT_VOUCHER requires valid from_account_id, to_account_id, and amount > 0");
    }

    return [
      { account_id: toAccount,   debit_amount: amount, credit_amount: 0,      description: narration || "Payment made" },
      { account_id: fromAccount, debit_amount: 0,      credit_amount: amount, description: narration || "Bank credited" },
    ];
  }
}

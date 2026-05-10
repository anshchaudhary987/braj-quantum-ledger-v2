import { PoolClient } from "pg";
import { VoucherStrategy } from "./voucher-strategy";
import { JournalLine, VoucherPayload } from "../models/types";

/**
 * RECEIPT_VOUCHER
 * Business rule: Debit the Bank account, Credit the Customer / Income account.
 *
 * Expected payload:
 * {
 *   to_account_id:   number,   // Bank account (debited)
 *   from_account_id: number,   // Customer / Income account (credited)
 *   amount:          number,
 *   narration?:      string
 * }
 */
export class ReceiptVoucherStrategy implements VoucherStrategy {
  readonly voucherType = "RECEIPT_VOUCHER";

  async translate(
    _client: PoolClient,
    payload: VoucherPayload,
    _tenantId: string,
    _txnDate: string
  ): Promise<JournalLine[]> {
    const toAccount   = Number(payload.to_account_id);
    const fromAccount = Number(payload.from_account_id);
    const amount      = Number(payload.amount);
    const narration   = String(payload.narration ?? "");

    if (!toAccount || !fromAccount || !amount || amount <= 0) {
      throw new Error("RECEIPT_VOUCHER requires valid to_account_id, from_account_id, and amount > 0");
    }

    return [
      { account_id: toAccount,   debit_amount: amount, credit_amount: 0,      description: narration || "Receipt received" },
      { account_id: fromAccount, debit_amount: 0,      credit_amount: amount, description: narration || "Customer credited" },
    ];
  }
}
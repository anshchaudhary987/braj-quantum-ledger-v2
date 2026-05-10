import { PoolClient } from "pg";
import { withClient, withTransaction } from "./db/pool.js";
import { TransactionManager } from "./services/transaction-manager.js";
import { VoucherFactory } from "./vouchers/voucher-factory.js";
import { PaymentVoucherStrategy } from "./vouchers/payment-voucher.js";
import { ReceiptVoucherStrategy } from "./vouchers/receipt-voucher.js";
import { SalaryVoucherStrategy } from "./vouchers/salary-voucher.js";
import { PurchaseInvoiceVoucherStrategy } from "./vouchers/purchase-voucher.js";
import { CreateTransactionInput } from "./models/types.js";
import { IdempotencyConflictError } from "./errors.js";

// ---------------------------------------------------------------------------
// Bootstrap: register all voucher strategies at startup
// ---------------------------------------------------------------------------
// The factory static-initialiser already does this, but explicit registration
// is shown here for clarity and for future custom strategies.
VoucherFactory.register(new PaymentVoucherStrategy());
VoucherFactory.register(new ReceiptVoucherStrategy());
VoucherFactory.register(new SalaryVoucherStrategy());
VoucherFactory.register(new PurchaseInvoiceVoucherStrategy());

// ---------------------------------------------------------------------------
// API handler — called by Express/Fastify/Hono route handler
// ---------------------------------------------------------------------------
export async function handleCreateTransaction(
  input: CreateTransactionInput
): Promise<{ transactionId: number }> {
  return withClient(async (client) => {
    return withTransaction(client, async (txClient: PoolClient) => {
      const manager = new TransactionManager(txClient);

      try {
        const result = await manager.create(input);
        return result;
      } catch (err) {
        // If the idempotency key already exists and was processed, return
        // the existing transaction_id instead of throwing.
        if (err instanceof IdempotencyConflictError && err.existingTransactionId) {
          return { transactionId: err.existingTransactionId };
        }
        throw err;
      }
    });
  });
}

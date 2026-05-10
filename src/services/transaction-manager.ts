import { PoolClient } from "pg";
import { VoucherFactory } from "../vouchers/voucher-factory.js";
import {
  CreateTransactionInput,
  JournalLine,
  TransactionRow,
} from "../models/types";
import {
  IdempotencyConflictError,
  InsufficientBalanceError,
} from "../errors";

/**
 * TRANSACTION MANAGER SERVICE
 *
 * Core responsibilities:
 * 1. Wraps every entry in a strict ACID database transaction.
 * 2. Delegates voucher-type translation to the Strategy/Factory layer.
 * 3. Acquires row-level locks (SELECT ... FOR UPDATE) on affected accounts
 *    to eliminate race conditions on shared balances.
 * 4. Enforces idempotency via idempotency_key — one key = one transaction.
 */
export class TransactionManager {
  constructor(private readonly client: PoolClient) {}

  // ---------------------------------------------------------------------------
  // PUBLIC ENTRY POINT
  // ---------------------------------------------------------------------------
  async create(input: CreateTransactionInput): Promise<{ transactionId: number }> {
    // ---------- STEP 1: Idempotency check ----------
    const existing = await this.checkIdempotency(
      input.idempotency_key,
      input.tenant_id
    );

    if (existing) {
      // Client retried a request that already succeeded — return the existing
      // transaction_id instead of creating a duplicate.
      return { transactionId: existing };
    }

    // ---------- STEP 2: Translate voucher -> journal lines ----------
    const strategy = VoucherFactory.resolve(input.voucher_type);

    const lines = await strategy.translate(
      this.client,
      input.voucher_payload,
      input.tenant_id,
      input.txn_date
    );

    // ---------- STEP 3: Acquire row-level locks on ALL affected accounts ----------
    await this.lockAccounts(lines, input.tenant_id);

    // (Optional) Validate balances post-lock — e.g. ensure a bank account
    // being credited doesn't go negative if you enforce positive balances.
    await this.validateBalances(lines, input.voucher_type);

    // ---------- STEP 4: Record idempotency claim ----------
    await this.recordIdempotencyKey(input.idempotency_key, input.tenant_id);

    // ---------- STEP 5: Insert transaction header ----------
    const txn = await this.insertTransaction(input);

    // ---------- STEP 6: Insert journal lines ----------
    await this.insertJournalLines(txn.transaction_id, lines);

    // ---------- STEP 7: Finalize idempotency key ----------
    await this.finalizeIdempotency(
      input.idempotency_key,
      input.tenant_id,
      txn.transaction_id
    );

    // ---------- STEP 8: Release locks (implicit at COMMIT) ----------
    return { transactionId: txn.transaction_id };
  }

  // ---------------------------------------------------------------------------
  // IDEMPOTENCY
  // ---------------------------------------------------------------------------

  /**
   * Returns an existing transaction_id if this idempotency_key was already
   * used, otherwise null.
   */
  private async checkIdempotency(
    key: string,
    tenantId: string
  ): Promise<number | null> {
    const { rows } = await this.client.query<{ transaction_id: number }>(
      `SELECT transaction_id
       FROM idempotency_keys
       WHERE idempotency_key = $1
         AND tenant_id       = $2
       LIMIT 1`,
      [key, tenantId]
    );
    return rows.length > 0 ? rows[0].transaction_id : null;
  }

  /**
   * Inserts a row into idempotency_keys.
   * This table has a UNIQUE(idempotency_key, tenant_id) constraint
   * so concurrent inserts for the same key will fail-fast with a
   * unique-violation, protecting against a race on the check above.
   */
  private async recordIdempotencyKey(
    key: string,
    tenantId: string
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO idempotency_keys (idempotency_key, tenant_id, transaction_id, status, created_at)
       VALUES ($1, $2, NULL, 'PROCESSING', now())`,
      [key, tenantId]
    );
  }

  /**
   * AFTER the transaction header is inserted we update the idempotency row
   * to link it. Called by the caller (create) once the header is in place.
   */
  async finalizeIdempotency(
    key: string,
    tenantId: string,
    transactionId: number
  ): Promise<void> {
    await this.client.query(
      `UPDATE idempotency_keys
       SET transaction_id = $3, status = 'COMPLETED'
       WHERE idempotency_key = $1 AND tenant_id = $2`,
      [key, tenantId, transactionId]
    );
  }

  // ---------------------------------------------------------------------------
  // CONCURRENCY — ROW-LEVEL LOCKING
  // ---------------------------------------------------------------------------

  /**
   * SELECT ... FOR UPDATE locks the account rows in the current transaction.
   * Any other concurrent transaction attempting to lock the same accounts
   * will BLOCK until this transaction COMMITs or ROLLBACKs.
   *
   * This guarantees that balance reads + writes are serialised per account.
   */
  private async lockAccounts(lines: JournalLine[], tenantId: string): Promise<void> {
    const accountIds = [...new Set(lines.map((l) => l.account_id))];

    const { rows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id
       FROM accounts
       WHERE account_id = ANY($1::bigint[])
         AND company_id = $2
       FOR UPDATE`,
      [accountIds, Number(tenantId)]
    );

    if (rows.length !== accountIds.length) {
      throw new Error("One or more accounts are not available for this tenant");
    }
  }

  /**
   * After locking, you can safely compute balances and enforce business rules.
   * Example: prevent an account with a positive-balance-only constraint from
   * being credited beyond its current balance.
   */
  private async validateBalances(
    lines: JournalLine[],
    voucherType: string
  ): Promise<void> {
    // Gather accounts that are being CREDITED (cash leaving the account)
    const creditedIds = lines
      .filter((l) => l.credit_amount > 0)
      .map((l) => l.account_id);

    if (creditedIds.length === 0) return;

    // Compute current balance for those accounts (debits - credits)
    const { rows } = await this.client.query<{
      account_id: number;
      balance: string;
    }>(
      `SELECT account_id,
              COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(credit_amount), 0) AS balance
       FROM journal_entries
       WHERE account_id = ANY($1::bigint[])
       GROUP BY account_id`,
      [creditedIds]
    );

    const balanceMap = new Map<number, number>();
    for (const r of rows) {
      balanceMap.set(r.account_id, Number(r.balance));
    }

    for (const line of lines) {
      if (line.credit_amount > 0) {
        const currentBalance = balanceMap.get(line.account_id) ?? 0;
        const newBalance = currentBalance - line.credit_amount;

        // Example rule: Asset accounts must not go below zero
        // In practice, query the account_type to decide this.
        if (newBalance < 0) {
          throw new InsufficientBalanceError(
            `Account ${line.account_id} would have negative balance (${newBalance}) after this transaction`
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PERSISTENCE
  // ---------------------------------------------------------------------------

  private async insertTransaction(
    input: CreateTransactionInput
  ): Promise<TransactionRow> {
    const { rows } = await this.client.query<TransactionRow>(
      `INSERT INTO transactions (tenant_id, txn_date, description, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.tenant_id,
        input.txn_date,
        input.description,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return rows[0];
  }

  private async insertJournalLines(
    transactionId: number,
    lines: JournalLine[]
  ): Promise<void> {
    if (lines.length === 0) return;

    // Bulk INSERT via multi-row VALUES for a single round-trip
    const values: unknown[] = [];
    const placeholders: string[] = [];

    lines.forEach((line, i) => {
      const base = i * 5;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
      );
      values.push(
        transactionId,
        line.account_id,
        line.debit_amount,
        line.credit_amount,
        line.description ?? null
      );
    });

    await this.client.query(
      `INSERT INTO journal_entries (transaction_id, account_id, debit_amount, credit_amount, description)
       VALUES ${placeholders.join(", ")}`,
      values
    );
  }
}

export interface CreateTransactionInput {
  idempotency_key: string;
  tenant_id: string;
  txn_date: string;          // YYYY-MM-DD
  description: string;
  voucher_type: string;
  voucher_payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface TransactionRow {
  transaction_id: number;
  tenant_id: string;
  txn_date: string;
  description: string;
  metadata: Record<string, unknown>;
  created_at: string;
  version: number;
}

export interface JournalEntryRow {
  entry_id: number;
  transaction_id: number;
  account_id: number;
  debit_amount: string;      // NUMERIC returned as string by pg
  credit_amount: string;
  description: string | null;
}

export interface JournalLine {
  account_id: number;
  debit_amount: number;
  credit_amount: number;
  description?: string;
}

export interface VoucherResult {
  lines: JournalLine[];
  transaction_detail: {
    description: string;
    metadata: Record<string, unknown>;
  };
}

export interface VoucherPayload {
  [key: string]: unknown;
}

import { PoolClient } from "pg";
import { JournalLine, VoucherPayload } from "../models/types.js";

/**
 * Strategy interface — every voucher type implements this to translate
 * a domain-specific payload into balanced debit/credit lines.
 */
export interface VoucherStrategy {
  readonly voucherType: string;

  /**
   * Translate a business payload into balanced journal lines.
   * Optionally returns enriched txn description + metadata.
   */
  translate(
    client: PoolClient,
    payload: VoucherPayload,
    tenantId: string,
    txnDate: string
  ): Promise<JournalLine[]>;
}

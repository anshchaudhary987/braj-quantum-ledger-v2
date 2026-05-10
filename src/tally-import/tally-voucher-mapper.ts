// ============================================================================
// TALLY VOUCHER MAPPER — VOUCHER → journal_entries
//
// Phase 2 of the Tally import pipeline.
//
// Logic:
//   1. For each <VOUCHER> in Tally XML:
//      a. Map VOUCHERTYPENAME → internal voucher_type
//      b. Resolve each LEDGERNAME → account_id via tally_master_mapping
//      c. Convert AMOUNT + ISDEEMEDPOSITIVE → debit/credit amounts
//      d. Batch-insert 500 vouchers per DB transaction
//
// Tally Debit/Credit Convention:
//   - ISDEEMEDPOSITIVE = "Yes" → amount is POSITIVE for this ledger type
//   - For asset/expense ledgers, "Yes" + positive = DEBIT
//   - For liability/income ledgers, "Yes" + positive = CREDIT
//   - "No" inverts the natural side
//
// Simplified mapping used here: ISDEEMEDPOSITIVE "Yes" means DEBIT side,
// "No" means CREDIT side for the most common cases.
// ============================================================================

import { PoolClient } from "pg";
import { TallyVoucher, TallyAllLedgerEntry } from "./tally-types.js";
import { parseTallyDate, normalizeAccountName } from "./tally-xml-parser.js";

/**
 * Map Tally VOUCHERTYPENAME to our internal voucher_type
 */
const VOUCHER_TYPE_MAP: Record<string, string> = {
  "Sales":           "SALES_VOUCHER",
  "Credit Note":     "SALES_VOUCHER",
  "Purchase":        "PURCHASE_INVOICE_VOUCHER",
  "Debit Note":      "PURCHASE_INVOICE_VOUCHER",
  "Receipt":         "RECEIPT_VOUCHER",
  "Payment":         "PAYMENT_VOUCHER",
  "Contra":          "CONTRA_VOUCHER",
  "Journal":         "JOURNAL_VOUCHER",
  "Reversing Journal":"JOURNAL_VOUCHER",
  "Payroll":         "SALARY_VOUCHER",
};

export interface MappedVoucher {
  tally_voucher_key: string;
  voucher_type: string;
  txn_date: string;
  description: string;
  reference: string;
  voucher_number: string;
  lines: MappedJournalLine[];
  tally_debit_total: number;
  tally_credit_total: number;
}

export interface MappedJournalLine {
  account_id: number;
  debit_amount: number;
  credit_amount: number;
  description: string;
  ledger_name: string;
}

export class TallyVoucherMapper {
  constructor(private readonly client: PoolClient) {}

  /**
   * Map a single Tally voucher to internal journal lines.
   */
  async mapVoucher(
    voucher: TallyVoucher,
    tenantId: string,
    importBatchId: string
  ): Promise<MappedVoucher | null> {
    const voucherType = VOUCHER_TYPE_MAP[voucher.VOUCHERTYPENAME] ?? "JOURNAL_VOUCHER";

    if (!voucherType) return null;

    const txnDate = parseTallyDate(voucher.DATE);
    const entries = voucher.ALLLEDGERENTRIES?.LIST ?? [];

    if (entries.length < 2) return null; // must have at least 2 entries

    // Resolve each ledger entry to an account_id
    const lines: MappedJournalLine[] = [];
    let tallyDebitTotal = 0;
    let tallyCreditTotal = 0;

    for (const entry of entries) {
      const accountId = await this.resolveLedgerAccount(entry.LEDGERNAME, tenantId, importBatchId);
      if (!accountId) {
        // Unknown ledger — try to find by name in accounts
        const fallbackId = await this.findAccountFallback(entry.LEDGERNAME);
        if (!fallbackId) continue; // skip unresolvable entries
        lines.push({
          account_id: fallbackId,
          debit_amount: 0,
          credit_amount: 0,
          description: "",
          ledger_name: entry.LEDGERNAME,
        });
        continue;
      }

      // ISDEEMEDPOSITIVE: "Yes" = natural side (Asset/Expense = DR, Liab/Income = CR)
      // Simplified: "Yes" → Debit, "No" → Credit
      const debitAmount = entry.ISDEEMEDPOSITIVE === "Yes" ? entry.AMOUNT : 0;
      const creditAmount = entry.ISDEEMEDPOSITIVE === "No" ? Math.abs(entry.AMOUNT) : 0;

      tallyDebitTotal += debitAmount;
      tallyCreditTotal += creditAmount;

      lines.push({
        account_id: accountId,
        debit_amount: debitAmount,
        credit_amount: creditAmount,
        description: `${voucher.VOUCHERTYPENAME}: ${voucher.VOUCHERNUMBER}`,
        ledger_name: entry.LEDGERNAME,
      });
    }

    const mapped: MappedVoucher = {
      tally_voucher_key: voucher.VOUCHERKEY ?? voucher.GUID ?? `${voucher.VOUCHERTYPENAME}_${voucher.VOUCHERNUMBER}_${voucher.DATE}`,
      voucher_type: voucherType,
      txn_date: txnDate,
      description: voucher.NARRATION || `${voucher.VOUCHERTYPENAME} #${voucher.VOUCHERNUMBER}`,
      reference: voucher.REFERENCE ?? "",
      voucher_number: voucher.VOUCHERNUMBER,
      lines,
      tally_debit_total: tallyDebitTotal,
      tally_credit_total: tallyCreditTotal,
    };

    return mapped;
  }

  /**
   * Resolve a Tally ledger name to internal account_id via master mapping.
   */
  async resolveLedgerAccount(
    tallyLedgerName: string,
    tenantId: string,
    importBatchId: string
  ): Promise<number | null> {
    const normalized = normalizeAccountName(tallyLedgerName);

    // 1. Check tally_master_mapping
    const { rows: mapRows } = await this.client.query<{ mapped_account_id: number }>(
      `SELECT mapped_account_id FROM tally_master_mapping
       WHERE tenant_id = $1 AND tally_name = $2 AND mapped_account_id IS NOT NULL
       LIMIT 1`,
      [tenantId, normalized]
    );
    if (mapRows.length > 0) return mapRows[0].mapped_account_id;

    // 2. Check existing accounts by name
    const { rows: accRows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM accounts WHERE account_name = $1 AND is_active = TRUE LIMIT 1`,
      [normalized]
    );
    if (accRows.length > 0) return accRows[0].account_id;

    return null;
  }

  private async findAccountFallback(name: string): Promise<number | null> {
    const { rows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM accounts WHERE account_name ILIKE $1 AND is_active = TRUE LIMIT 1`,
      [`%${name}%`]
    );
    return rows[0]?.account_id ?? null;
  }
}

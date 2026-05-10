import { PoolClient } from "pg";
import crypto from "crypto";
import { MatchingEngine } from "./matching-engine.js";
import { TransactionManager } from "../services/transaction-manager.js";
import {
  BankStatementRow,
  BankStatementImportInput,
  BankStatementImportResult,
  UnreconciledEntryView,
  CreateVoucherFromBankEntryInput,
  MatchCandidate,
  AutoMatchResult,
} from "./banking-types";
import { AppError } from "../api/auth/auth-service.js";
import { ErrorCode } from "../api/errors.js";

// ---------------------------------------------------------------------------
// BANK STATEMENT SERVICE — Import, AA Fetch, Unreconciled Queue, One-Click Voucher
// ---------------------------------------------------------------------------

export class BankStatementService {
  constructor(private readonly client: PoolClient) {}

  // -----------------------------------------------------------------------
  // IMPORT — Parse bank CSV and load into bank_statements
  // -----------------------------------------------------------------------
  async importStatement(
    input: BankStatementImportInput,
    companyId: number
  ): Promise<BankStatementImportResult> {
    const batchId = crypto.randomUUID();

    // Parse the CSV/Excel file (production: use a dedicated parser like papaparse/xlsx)
    const rows = this.parseBankFile(input.file_buffer, input.file_format);

    if (rows.length === 0) {
      return {
        batch_id: batchId,
        total_rows: 0, rows_imported: 0, rows_skipped: 0,
        rows_auto_matched: 0, rows_suggested: 0, rows_unreconciled: 0,
      };
    }

    let imported = 0;
    let skipped = 0;

    // Validate bank account belongs to this company
    const { rows: bankRows } = await this.client.query<{ bank_account_id: number }>(
      `SELECT bank_account_id FROM bank_accounts
       WHERE bank_account_id = $1 AND company_id = $2`,
      [input.bank_account_id, companyId]
    );

    if (bankRows.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, "Bank account not found for this company.");
    }

    // Insert rows, skip duplicates (same date + amount + ref for same bank account)
    for (const row of rows) {
      const existing = await this.client.query<{ bank_statement_id: number }>(
        `SELECT bank_statement_id FROM bank_statements
         WHERE bank_account_id  = $1
           AND transaction_date = $2
           AND transaction_ref  = $3
           AND COALESCE(debit_amount,  0) = $4
           AND COALESCE(credit_amount, 0) = $5
           AND company_id       = $6
         LIMIT 1`,
        [input.bank_account_id, row.date, row.ref, row.debit, row.credit, companyId]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      await this.client.query(
        `INSERT INTO bank_statements
           (company_id, bank_account_id, transaction_date, value_date,
            description, transaction_ref, transaction_type,
            debit_amount, credit_amount, running_balance,
            source, source_file_name, source_line_number, import_batch_id, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IMPORT', $11, $12, $13, $14)
         RETURNING bank_statement_id`,
        [
          companyId, input.bank_account_id,
          row.date, row.valueDate, row.description, row.ref, row.type,
          row.debit, row.credit, row.balance,
          input.file_name, row.lineNumber, batchId, JSON.stringify(row.raw ?? {}),
        ]
      );
      imported++;
    }

    // Auto-match the newly imported rows
    const { rows: newRows } = await this.client.query<BankStatementRow>(
      `SELECT * FROM bank_statements WHERE import_batch_id = $1`,
      [batchId]
    );

    const matchedIds = newRows.map(r => r.bank_statement_id);
    const engine = new MatchingEngine(this.client);
    const matchResults = await engine.reconcileBatch(matchedIds, companyId);

    return {
      batch_id: batchId,
      total_rows: rows.length,
      rows_imported: imported,
      rows_skipped: skipped,
      rows_auto_matched: matchResults.filter(r => r.status === "MATCHED").length,
      rows_suggested: matchResults.filter(r => r.status === "SUGGESTED").length,
      rows_unreconciled: matchResults.filter(r => r.status === "UNRECONCILED").length,
    };
  }

  // -----------------------------------------------------------------------
  // UNRECONCILED QUEUE — Fetch unmatched entries for review
  // -----------------------------------------------------------------------
  async getUnreconciledEntries(
    companyId: number,
    bankAccountId?: number,
    limit: number = 50
  ): Promise<UnreconciledEntryView[]> {
    const params: unknown[] = [companyId, limit];
    let bankFilter = "";

    if (bankAccountId) {
      params.splice(1, 0, bankAccountId);
      bankFilter = `AND bs.bank_account_id = $2`;
    }

    const { rows } = await this.client.query<{
      bank_statement_id: number;
      bank_name: string;
      account_number_masked: string;
      transaction_date: string;
      description: string;
      transaction_ref: string | null;
      transaction_type: string | null;
      debit_amount: string;
      credit_amount: string;
      running_balance: string | null;
      reconciliation_status: string;
      match_confidence: string | null;
    }>(
      `SELECT bs.bank_statement_id, ba.bank_name, ba.account_number_masked,
              bs.transaction_date::TEXT, bs.description,
              bs.transaction_ref, bs.transaction_type,
              bs.debit_amount, bs.credit_amount, bs.running_balance,
              bs.reconciliation_status, bs.match_confidence
       FROM bank_statements bs
       JOIN bank_accounts ba ON ba.bank_account_id = bs.bank_account_id
       WHERE bs.company_id = $1
         AND bs.reconciliation_status IN ('UNRECONCILED', 'SUGGESTED')
         ${bankFilter}
       ORDER BY bs.transaction_date DESC
       LIMIT $${bankAccountId ? 3 : 2}`,
      params
    );

    const results: UnreconciledEntryView[] = [];

    for (const r of rows) {
      // For SUGGESTED entries, also fetch the top match candidates
      let matchCandidates: MatchCandidate[] | undefined;

      if (r.reconciliation_status === "SUGGESTED") {
        const bs = await this.client.query<BankStatementRow>(
          `SELECT * FROM bank_statements WHERE bank_statement_id = $1`,
          [r.bank_statement_id]
        );

        if (bs.rows[0]) {
          const engine = new MatchingEngine(this.client);
          const candidates = await engine.findCandidates(bs.rows[0], companyId);

          matchCandidates = candidates.map(c => ({
            bank_statement_id: r.bank_statement_id,
            journal_entry_id: c.journal_entry_id,
            transaction_id: c.transaction_id,
            confidence: c.score,
            match_rule: Object.entries(c.score_breakdown)
              .map(([k, v]) => `${k}:${v}`)
              .join("|"),
            description: "",
            amount: Math.abs(Number(r.debit_amount) || Number(r.credit_amount)),
            bank_date: r.transaction_date,
          }));
        }
      }

      results.push({
        bank_statement_id: r.bank_statement_id,
        bank_name: r.bank_name,
        account_number_masked: r.account_number_masked,
        transaction_date: r.transaction_date,
        description: r.description,
        transaction_ref: r.transaction_ref,
        transaction_type: r.transaction_type,
        debit_amount: Number(r.debit_amount),
        credit_amount: Number(r.credit_amount),
        running_balance: r.running_balance ? Number(r.running_balance) : null,
        status: r.reconciliation_status as "UNRECONCILED" | "SUGGESTED",
        match_candidates: matchCandidates,
      });
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // ONE-CLICK VOUCHER — Create a Payment/Receipt voucher from a bank entry
  // -----------------------------------------------------------------------
  async createVoucherFromBankEntry(
    input: CreateVoucherFromBankEntryInput,
    companyId: number,
    userId: number
  ): Promise<{ transaction_id: number; bank_statement_id: number }> {
    // 1. Load the bank statement row
    const { rows: bankRows } = await this.client.query<BankStatementRow>(
      `SELECT * FROM bank_statements
       WHERE bank_statement_id = $1 AND company_id = $2
       FOR UPDATE`,
      [input.bank_statement_id, companyId]
    );

    const bankEntry = bankRows[0];
    if (!bankEntry) {
      throw new AppError(ErrorCode.NOT_FOUND, "Bank statement entry not found.");
    }

    if (bankEntry.reconciliation_status === "MATCHED") {
      throw new AppError(ErrorCode.CONFLICT, "This bank entry is already reconciled.");
    }

    // 2. Determine the amount and direction
    const amount    = Number(bankEntry.debit_amount) || Number(bankEntry.credit_amount);
    const bankAccountId = bankEntry.bank_account_id;

    // Load the bank account → get the linked ledger account_id
    const { rows: baRows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM bank_accounts WHERE bank_account_id = $1`,
      [bankAccountId]
    );

    const bankLedgerAccountId = baRows[0]?.account_id;
    if (!bankLedgerAccountId) {
      throw new AppError(ErrorCode.NOT_FOUND, "Bank ledger account not mapped.");
    }

    // 3. Debit/Credit mapping:
    //    Bank DEBIT (money LEAVING bank) = PAYMENT → Credit Bank, Debit Vendor
    //    Bank CREDIT (money ENTERING bank) = RECEIPT → Debit Bank, Credit Customer
    const isBankDebit = Number(bankEntry.debit_amount) > 0;

    // 4. Determine the correct voucher type
    let voucherType = input.voucher_type;

    if (isBankDebit && voucherType !== "PAYMENT_VOUCHER") {
      voucherType = "PAYMENT_VOUCHER";
    } else if (!isBankDebit && voucherType !== "RECEIPT_VOUCHER") {
      voucherType = "RECEIPT_VOUCHER";
    }

    // 5. Build the voucher payload
    const narration = input.narration
      ?? `Auto-created from bank entry: ${bankEntry.description} (ref: ${bankEntry.transaction_ref ?? "N/A"})`;

    const txnMgr = new TransactionManager(this.client);
    const result = await txnMgr.create({
      idempotency_key: input.idempotency_key,
      tenant_id: String(companyId),
      txn_date: bankEntry.transaction_date,
      description: narration,
      voucher_type: "PAYMENT_VOUCHER", // handled by the appropriate strategy
      voucher_payload: {
        // For PAYMENT: from_account = bank, to_account = vendor
        // For RECEIPT: to_account = bank, from_account = customer
        from_account_id: voucherType === "PAYMENT_VOUCHER"
          ? bankLedgerAccountId
          : input.ledger_account_id,
        to_account_id: voucherType === "PAYMENT_VOUCHER"
          ? input.ledger_account_id
          : bankLedgerAccountId,
        amount,
        narration,
        reference_number: bankEntry.transaction_ref,
      },
      metadata: {
        source: "BANK_RECONCILIATION",
        bank_statement_id: bankEntry.bank_statement_id,
        bank_transaction_ref: bankEntry.transaction_ref,
        bank_description: bankEntry.description,
      },
    });

    // 6. Mark the bank entry as reconciled
    await this.client.query(
      `UPDATE bank_statements
       SET reconciliation_status = 'MATCHED',
           matched_transaction_id = $1,
           match_rule             = 'MANUAL_VOUCHER',
           reconciled_by          = $2,
           reconciled_at          = now(),
           reconciliation_notes   = $3
       WHERE bank_statement_id = $4`,
      [result.transactionId, userId, narration, input.bank_statement_id]
    );

    return {
      transaction_id: result.transactionId,
      bank_statement_id: bankEntry.bank_statement_id,
    };
  }

  // -----------------------------------------------------------------------
  // AA INTEGRATION — Account Aggregator (Sahamati) Flow
  // -----------------------------------------------------------------------
  //
  //   ┌──────────┐     ┌──────────┐     ┌──────────┐
  //   │   FIU    │────▶│    AA    │────▶│   FIP    │
  //   │ (Our App)│     │(Sahamati)│     │  (Bank)  │
  //   └──────────┘     └──────────┘     └──────────┘
  //
  // Step-by-step flow:
  //
  //  1. User DISCOVERS their bank accounts via the AA gateway.
  //     GET /aa/fips?search=HDFC → returns list of banks (FIPs)
  //
  //  2. User initiates CONSENT.
  //     POST /aa/consents/initiate
  //     {
  //       fip_id: "HDFC-BANK",
  //       fi_types: ["DEPOSIT"],
  //       date_range: { from: "2025-04-01", to: "2026-03-31" },
  //       purpose: "Financial reporting and reconciliation"
  //     }
  //     → AA returns consent_handle + redirect_url.
  //
  //  3. User is redirected to the AA consent page (OAuth-like).
  //     User approves → AA redirects back with consent_handle.
  //
  //  4. We store the consent in aa_consents table.
  //     POST /aa/consents/store  { consent_handle }
  //
  //  5. We REQUEST data.
  //     POST /aa/fi/request
  //     {
  //       consent_handle: "abc-123",
  //       fip_id: "HDFC-BANK",
  //       date_range: { from: "2025-04-01", to: "2026-03-31" }
  //     }
  //     → AA returns a session_id.
  //
  //  6. We POLL for data (async — bank may take seconds to respond).
  //     GET /aa/fi/fetch/{session_id}
  //     → AA returns encrypted FI data blob.
  //
  //  7. We DECRYPT the FI data using our private key.
  //     {
  //       account: { masked_number: "XXXX7890", type: "SAVINGS" },
  //       transactions: [
  //         { date: "2025-04-15", amount: 50000, mode: "NEFT", ref: "UTR001" },
  //         ...
  //       ]
  //     }
  //
  //  8. We UPSERT the transactions into bank_statements with source="AA_FETCH".
  //     Duplicates are skipped (same bank_account + date + amount + ref).
  //
  //  9. We trigger auto-reconciliation on the newly fetched entries.

  // The following outlines the AA service interface:

  async discoverFips(): Promise<Array<{ fip_id: string; fip_name: string }>> {
    // → External API GET to AA gateway
    // Returns registered FIPs (banks)
    console.log("[AA] Discovering FIPs via AA gateway...");
    return [
      { fip_id: "HDFC-BANK", fip_name: "HDFC Bank" },
      { fip_id: "SBI-BANK",  fip_name: "State Bank of India" },
      { fip_id: "ICICI-BANK", fip_name: "ICICI Bank" },
    ];
  }

  async initiateConsent(
    bankAccountId: number,
    fipId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<string> {
    // → External API POST to AA gateway
    // Store consent handle in aa_consents table
    const consentHandle = `consent-${crypto.randomUUID()}`; // placeholder

    await this.client.query(
      `INSERT INTO aa_consents
         (company_id, bank_account_id, consent_handle, consent_status,
          fi_data_range_from, fi_data_range_to, fip_id,
          consent_granted_at, consent_expires_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, now(), now() + INTERVAL '90 days')`,
      [1, bankAccountId, consentHandle, dateFrom, dateTo, fipId] // company_id from context
    );

    return consentHandle;
  }

  async fetchAAStatements(
    bankAccountId: number,
    consentHandle: string,
    dateFrom: string,
    dateTo: string,
    companyId: number
  ): Promise<{ imported: number; skipped: number }> {
    // 1. Validate consent is active
    const { rows: consentRows } = await this.client.query(
      `SELECT consent_status FROM aa_consents
       WHERE consent_handle = $1 AND bank_account_id = $2 AND consent_status = 'ACTIVE'`,
      [consentHandle, bankAccountId]
    );

    if (consentRows.length === 0) {
      throw new AppError(ErrorCode.FORBIDDEN, "No active AA consent found for this bank account.");
    }

    // 2. Poll the AA gateway for FI data (external API call)
    // const fiData = await aaGateway.fetch(consentHandle, dateFrom, dateTo);
    const fiData = this.mockAAData();

    // 3. Upsert transactions into bank_statements
    let imported = 0;
    let skipped = 0;

    for (const txn of fiData.transactions) {
      const existing = await this.client.query<{ bank_statement_id: number }>(
        `SELECT bank_statement_id FROM bank_statements
         WHERE bank_account_id  = $1 AND transaction_date = $2
           AND transaction_ref  = $3 AND company_id = $4
           AND COALESCE(debit_amount, 0)  = COALESCE($5, 0)
           AND COALESCE(credit_amount, 0) = COALESCE($6, 0)
         LIMIT 1`,
        [bankAccountId, txn.date, txn.ref, companyId, txn.debit, txn.credit]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      await this.client.query(
        `INSERT INTO bank_statements
           (company_id, bank_account_id, transaction_date, description,
            transaction_ref, transaction_type,
            debit_amount, credit_amount,
            source, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AA_FETCH', $9)`,
        [
          companyId, bankAccountId,
          txn.date, txn.description, txn.ref, txn.mode,
          txn.debit, txn.credit,
          JSON.stringify(txn),
        ]
      );
      imported++;
    }

    // 4. Update consent last_fetch_at
    await this.client.query(
      `UPDATE aa_consents SET last_fetch_at = now(), last_fetch_success = TRUE
       WHERE consent_handle = $1`,
      [consentHandle]
    );

    return { imported, skipped };
  }

  // -----------------------------------------------------------------------
  // CSV PARSER — Bank statement file parsing
  // -----------------------------------------------------------------------
  private parseBankFile(
    buffer: Buffer,
    format: string
  ): Array<{
    lineNumber: number;
    date: string;
    valueDate: string | null;
    description: string;
    ref: string | null;
    type: string | null;
    debit: number;
    credit: number;
    balance: number | null;
    raw: Record<string, unknown> | null;
  }> {
    // Production: use papaparse for CSV, xlsx for Excel, or a PDF parser.
    // This is a placeholder that handles common Indian bank CSV formats.
    const csvText = buffer.toString("utf8");
    const lines = csvText.split("\n").filter(l => l.trim());

    const results: ReturnType<typeof this.parseBankFile> = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length < 4) continue;

      results.push({
        lineNumber: i + 1,
        date: cols[0]?.trim() ?? "",
        valueDate: cols[1]?.trim() || null,
        description: cols[2]?.trim() ?? "",
        ref: cols[3]?.trim() || null,
        type: cols[4]?.trim() || null,
        debit: parseFloat(cols[5]) || 0,
        credit: parseFloat(cols[6]) || 0,
        balance: cols[7] ? parseFloat(cols[7]) : null,
        raw: null,
      });
    }

    return results;
  }

  private mockAAData(): {
    transactions: Array<{
      date: string; description: string; ref: string | null;
      mode: string | null; debit: number; credit: number;
    }>;
  } {
    return {
      transactions: [
        {
          date: "2026-05-01", description: "NEFT Cr-VENDOR PAYMENT PVT LTD",
          ref: "NEFT000123456789", mode: "NEFT", debit: 0, credit: 25000,
        },
      ],
    };
  }
}

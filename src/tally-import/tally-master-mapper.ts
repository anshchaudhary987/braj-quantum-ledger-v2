// ============================================================================
// TALLY MASTER MAPPER — LEDGER/GROUP → accounts table
//
// Phase 1 of the Tally import pipeline.
//
// Logic:
//   1. For each <LEDGER> in Tally XML, check if it's a system default
//      (Cash, Profit & Loss A/c, etc.) → map to existing account or SKIP
//   2. For new ledgers → INSERT into accounts, map via tally_master_mapping
//   3. For <GROUP> tags → INSERT as parent accounts with ltree hierarchy
//
// Idempotency: Uses tally_guid (UNIQUE per tenant) for dedup.
// ============================================================================

import { PoolClient } from "pg";
import { TallyLedger, TallyGroup, TallyMasterMappingRow, Phase1Result } from "./tally-types";
import { normalizeAccountName, generateTallyAccountCode } from "./tally-xml-parser";

// Tally system defaults that should never create duplicates
const SYSTEM_DEFAULT_LEDGERS = new Set([
  "Cash", "Cash-in-hand", "Bank Accounts", "Capital Account",
  "Profit & Loss A/c", "Trading Account", "Balance Sheet",
  "Sales Accounts", "Purchase Accounts", "Sundry Debtors",
  "Sundry Creditors", "Duties & Taxes", "Loans (Liability)",
  "Loans & Advances (Asset)", "Stock-in-Hand", "Fixed Assets",
  "Investments", "Current Assets", "Current Liabilities",
  "Branch / Divisions", "Misc. Expenses (Asset)",
  "Suspense A/c", "Reserves & Surplus", "Secured Loans",
]);

export class TallyMasterMapper {
  constructor(private readonly client: PoolClient) {}

  /**
   * Map a Tally ledger to an internal account. Creates the account if
   * it doesn't exist, using the Tally GUID for deduplication.
   */
  async mapLedger(
    ledger: TallyLedger,
    importBatchId: string,
    tenantId: string
  ): Promise<{ mapping: TallyMasterMappingRow; created: boolean }> {
    const name = normalizeAccountName(ledger.NAME);
    const isSystem = SYSTEM_DEFAULT_LEDGERS.has(ledger.NAME);

    // Step 1: Check if already mapped via GUID
    if (ledger.GUID) {
      const existing = await this.findExistingMapping(ledger.GUID, tenantId);
      if (existing) return { mapping: existing, created: false };
    }

    // Step 2: Check if this is a system default with an existing account
    if (isSystem) {
      const existingAccount = await this.findAccountByName(name);
      if (existingAccount) {
        return { mapping: await this.insertMapping(ledger, importBatchId, tenantId, existingAccount, true), created: false };
      }
    }

    // Step 3: Create the account with proper hierarchy
    const parentPath = await this.resolveParentPath(ledger.PARENT, tenantId, importBatchId);
    const accountCode = generateTallyAccountCode(name, ledger.GUID);
    const accountType = await this.resolveAccountType(ledger.PARENT, tenantId, importBatchId);

    let accountId: number;
    const existingByCode = await this.findAccountByCode(accountCode);
    if (existingByCode) {
      accountId = existingByCode;
    } else {
      const { rows } = await this.client.query<{ account_id: number }>(
        `INSERT INTO accounts (parent_id, path, account_name, account_code, account_type)
         VALUES (
           NULL,
           $1,
           $2,
           $3,
           $4
         )
         ON CONFLICT (account_code) DO UPDATE SET account_name = EXCLUDED.account_name
         RETURNING account_id`,
        [null, name, accountCode, accountType]
      );
      accountId = rows[0].account_id;
    }

    return { mapping: await this.insertMapping(ledger, importBatchId, tenantId, accountId, isSystem), created: true };
  }

  /**
   * Map a Tally group to an internal account (as a parent/group node).
   */
  async mapGroup(
    group: TallyGroup,
    importBatchId: string,
    tenantId: string
  ): Promise<{ mapping: TallyMasterMappingRow; created: boolean }> {
    const name = normalizeAccountName(group.NAME);

    if (group.GUID) {
      const existing = await this.findExistingMapping(group.GUID, tenantId);
      if (existing) return { mapping: existing, created: false };
    }

    const existingAccount = await this.findAccountByName(name);
    if (existingAccount) {
      return { mapping: await this.insertMappingGroup(group, importBatchId, tenantId, existingAccount), created: false };
    }

    const accountType = this.resolveGroupAccountType(group.NAME);
    const accountCode = generateTallyAccountCode(name, group.GUID);

    const { rows } = await this.client.query<{ account_id: number }>(
      `INSERT INTO accounts (parent_id, path, account_name, account_code, account_type)
       VALUES (NULL, $1 || $2::ltree, $3, $4, $5)
       ON CONFLICT (account_code) DO UPDATE SET account_name = EXCLUDED.account_name
       RETURNING account_id`,
      ["", `${name.replace(/\s+/g, "_")}`, name, accountCode, accountType]
    );

    return { mapping: await this.insertMappingGroup(group, importBatchId, tenantId, rows[0].account_id), created: true };
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async findExistingMapping(guid: string, tenantId: string): Promise<TallyMasterMappingRow | null> {
    const { rows } = await this.client.query<TallyMasterMappingRow>(
      `SELECT * FROM tally_master_mapping
       WHERE tenant_id = $1 AND tally_guid = $2`,
      [tenantId, guid]
    );
    return rows[0] ?? null;
  }

  private async findAccountByName(name: string): Promise<number | null> {
    const { rows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM accounts WHERE account_name = $1 AND is_active = TRUE LIMIT 1`,
      [name]
    );
    return rows[0]?.account_id ?? null;
  }

  private async findAccountByCode(code: string): Promise<number | null> {
    const { rows } = await this.client.query<{ account_id: number }>(
      `SELECT account_id FROM accounts WHERE account_code = $1 LIMIT 1`,
      [code]
    );
    return rows[0]?.account_id ?? null;
  }

  private async resolveParentPath(
    _parentName: string,
    _tenantId: string,
    _importBatchId: string
  ): Promise<string> {
    // In a full implementation, walk up the Tally hierarchy
    // For now, use simple flat mapping
    return "";
  }

  private async resolveAccountType(
    parentName: string,
    _tenantId: string,
    _importBatchId: string
  ): Promise<string> {
    const { rows } = await this.client.query<{ tally_group_to_account_type: string }>(
      `SELECT tally_group_to_account_type($1) AS tally_group_to_account_type`,
      [parentName]
    );
    return rows[0]?.tally_group_to_account_type ?? "Expense";
  }

  private resolveGroupAccountType(groupName: string): string {
    if (/bank|cash/i.test(groupName)) return "Asset";
    if (/income|sales|revenue/i.test(groupName)) return "Income";
    if (/expense|purchase|cost/i.test(groupName)) return "Expense";
    if (/liabilit|payable|loan/i.test(groupName)) return "Liability";
    if (/capital|reserve|equity/i.test(groupName)) return "Equity";
    return "Asset";
  }

  private async insertMapping(
    ledger: TallyLedger,
    importBatchId: string,
    tenantId: string,
    accountId: number,
    isSystem: boolean
  ): Promise<TallyMasterMappingRow> {
    const { rows } = await this.client.query<TallyMasterMappingRow>(
      `INSERT INTO tally_master_mapping (
         tenant_id, import_batch_id, tally_guid, tally_name,
         tally_parent_name, tally_master_type, tally_opening_balance,
         mapped_account_id, is_system_default
       ) VALUES ($1,$2,$3,$4,$5,'LEDGER',$6,$7,$8)
       ON CONFLICT (tenant_id, tally_guid) DO UPDATE SET
         tally_name = EXCLUDED.tally_name,
         mapped_account_id = EXCLUDED.mapped_account_id
       RETURNING *`,
      [tenantId, importBatchId, ledger.GUID || null, normalizeAccountName(ledger.NAME),
       ledger.PARENT, ledger.OPENINGBALANCE, accountId, isSystem]
    );
    return rows[0];
  }

  private async insertMappingGroup(
    group: TallyGroup,
    importBatchId: string,
    tenantId: string,
    accountId: number
  ): Promise<TallyMasterMappingRow> {
    const { rows } = await this.client.query<TallyMasterMappingRow>(
      `INSERT INTO tally_master_mapping (
         tenant_id, import_batch_id, tally_guid, tally_name,
         tally_parent_name, tally_master_type, tally_opening_balance,
         mapped_account_id, is_system_default
       ) VALUES ($1,$2,$3,$4,$5,'GROUP',0,$6,FALSE)
       ON CONFLICT (tenant_id, tally_guid) DO UPDATE SET
         tally_name = EXCLUDED.tally_name,
         mapped_account_id = EXCLUDED.mapped_account_id
       RETURNING *`,
      [tenantId, importBatchId, group.GUID || null, normalizeAccountName(group.NAME),
       group.PARENT, accountId]
    );
    return rows[0];
  }
}
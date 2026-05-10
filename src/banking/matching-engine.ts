import { PoolClient } from "pg";
import {
  BankStatementRow,
  AutoMatchResult,
  ReconciliationRuleRow,
  ReconciliationStatus,
} from "./banking-types";

// ---------------------------------------------------------------------------
// MATCHING ENGINE — Weighted scoring algorithm for auto-reconciliation
// ---------------------------------------------------------------------------

/**
 * Scoring weights (from reconciliation_rules table, overrideable per company)
 *
 *   Exact amount match:        40 points  (bank debit ↔ journal credit)
 *   Date proximity:            30 points  (0 days=30, 1d=25, 2d=20, 3d=15)
 *   Reference number match:    30 points  (exact=30, partial last-6=15)
 *   Description fuzzy:         10 points  (trigram similarity > 0.6)
 *                                ═══════
 *   Maximum possible:         110 points
 *
 * Thresholds:
 *   ≥ 70% of max → AUTO-MATCH
 *   50–69%       → SUGGEST (pending user confirmation)
 *   < 50%        → UNRECONCILED
 */

export class MatchingEngine {
  private rules: ReconciliationRuleRow | null = null;

  constructor(private readonly client: PoolClient) {}

  /**
   * Run matching for a batch of bank statements (e.g. after import).
   * Calls the SQL function auto_reconcile_bank_entry() for each row.
   */
  async reconcileBatch(
    bankStatementIds: number[],
    companyId: number
  ): Promise<AutoMatchResult[]> {
    const results: AutoMatchResult[] = [];

    for (const id of bankStatementIds) {
      const { rows } = await this.client.query<{
        matched_entry_id: string | null;
        matched_txn_id: string | null;
        confidence: string | null;
        rule_used: string | null;
      }>(
        `SELECT matched_entry_id, matched_txn_id, confidence, rule_used
         FROM auto_reconcile_bank_entry($1, $2)`,
        [id, companyId]
      );

      const r = rows[0];
      results.push({
        bank_statement_id: id,
        status: await this.determineStatus(Number(r?.confidence ?? 0), companyId),
        matched_entry_id: r?.matched_entry_id ? Number(r.matched_entry_id) : undefined,
        matched_transaction_id: r?.matched_txn_id ? Number(r.matched_txn_id) : undefined,
        confidence: Number(r?.confidence ?? 0),
        match_rule: r?.rule_used ?? "",
      });
    }

    return results;
  }

  /**
   * Run matching for a SINGLE bank entry — used when manually triggering
   * re-match after editing a bank entry or creating a new voucher.
   */
  async reconcileSingle(
    bankStatementId: number,
    companyId: number
  ): Promise<AutoMatchResult> {
    const results = await this.reconcileBatch([bankStatementId], companyId);
    return results[0];
  }

  /**
   * TypeScript-native matching for a single bank entry.
   * Used when you need the match CANDIDATES list (not just the best match).
   */
  async findCandidates(
    bankStatement: BankStatementRow,
    companyId: number
  ): Promise<
    Array<{
      journal_entry_id: number;
      transaction_id: number;
      score: number;
      score_breakdown: Record<string, number>;
    }>
  > {
    const rules = await this.getRules(companyId);
    const bankAmount = Number(bankStatement.debit_amount) || Number(bankStatement.credit_amount);
    const isBankDebit = Number(bankStatement.debit_amount) > 0;  // money OUT of bank

    // Find journal entries for this bank account within date window
    const { rows: candidates } = await this.client.query<{
      entry_id: number;
      transaction_id: number;
      debit_amount: string;
      credit_amount: string;
      txn_date: string;
      txn_description: string;
      je_description: string | null;
      ref_number: string | null;
    }>(
      `SELECT je.entry_id, je.transaction_id,
              je.debit_amount, je.credit_amount,
              t.txn_date::TEXT,
              t.description AS txn_description,
              je.description AS je_description,
              t.metadata->>'reference_number' AS ref_number
       FROM journal_entries je
       JOIN transactions t ON t.transaction_id = je.transaction_id
       JOIN bank_accounts ba ON ba.account_id = je.account_id
       WHERE ba.bank_account_id = $1
         AND t.txn_date BETWEEN $2::DATE - $3
                            AND $2::DATE + $3
         AND (
             ($4 AND je.credit_amount = $5) OR
             (NOT $4 AND je.debit_amount = $5)
         )
         AND t.company_id = $6`,
      [
        bankStatement.bank_account_id,
        bankStatement.transaction_date,
        rules.date_proximity_days,
        isBankDebit,
        bankAmount,
        companyId,
      ]
    );

    if (candidates.length === 0) {
      return [];
    }

    // Score each candidate
    const scored = candidates.map((c) => {
      const breakdown: Record<string, number> = {};
      let score = 0;

      // ---- Rule 1: Amount match (guaranteed by the SQL filter) ----
      score += rules.amount_match_weight;
      breakdown["amount"] = rules.amount_match_weight;

      // ---- Rule 2: Date proximity ----
      const bankDate = new Date(bankStatement.transaction_date);
      const txnDate  = new Date(c.txn_date);
      const dateDiff = Math.abs(
        Math.round((bankDate.getTime() - txnDate.getTime()) / 86_400_000)
      );

      const datePoints = this.scoreDateProximity(dateDiff, rules);
      score += datePoints;
      breakdown["date"] = datePoints;

      // ---- Rule 3: Reference number match ----
      const bankRef = bankStatement.transaction_ref?.trim();
      let refPoints = 0;

      if (bankRef && c.ref_number) {
        if (c.ref_number === bankRef) {
          refPoints = rules.reference_match_weight;
        } else if (
          bankRef.length >= 6 &&
          c.ref_number.includes(bankRef.substring(bankRef.length - 6))
        ) {
          refPoints = Math.round(rules.reference_match_weight * 0.5);
        }
      }
      score += refPoints;
      breakdown["reference"] = refPoints;

      // ---- Rule 4: Description fuzzy match ----
      const descScore = this.fuzzyMatch(
        bankStatement.description,
        c.txn_description
      );
      const descPoints = Math.round(rules.description_match_weight * descScore);
      score += descPoints;
      breakdown["description"] = descPoints;

      const maxPossible = rules.amount_match_weight
                        + rules.date_proximity_weight
                        + rules.reference_match_weight
                        + rules.description_match_weight;

      return {
        journal_entry_id: c.entry_id,
        transaction_id: c.transaction_id,
        score: score / maxPossible,                          // normalize to 0–1
        score_breakdown: breakdown,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  // -----------------------------------------------------------------------
  // PRIVATE HELPERS
  // -----------------------------------------------------------------------
  private scoreDateProximity(
    dayDiff: number,
    rules: ReconciliationRuleRow
  ): number {
    if (dayDiff === 0) return rules.date_proximity_weight;
    if (dayDiff === 1) return Math.round(rules.date_proximity_weight * 0.85);
    if (dayDiff === 2) return Math.round(rules.date_proximity_weight * 0.70);
    if (dayDiff === 3) return Math.round(rules.date_proximity_weight * 0.50);
    return 0;
  }

  /**
   * Simple trigram-like fuzzy matching.
   * For production, call `similarity()` in PostgreSQL via the pg_trgm extension.
   */
  private fuzzyMatch(a: string, b: string): number {
    const aLower = a.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    const bLower = b.toLowerCase().replace(/[^a-z0-9\s]/g, "");

    if (aLower === bLower) return 1.0;
    if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.9;

    // Count common trigrams
    const triA = this.getTrigrams(aLower);
    const triB = new Set(this.getTrigrams(bLower));

    if (triA.length === 0 || triB.size === 0) return 0;

    let matches = 0;
    for (const t of triA) {
      if (triB.has(t)) matches++;
    }

    return matches / Math.max(triA.length, triB.size);
  }

  private getTrigrams(s: string): string[] {
    const trigrams: string[] = [];
    const padded = `  ${s} `;
    for (let i = 0; i < padded.length - 2; i++) {
      trigrams.push(padded.substring(i, i + 3));
    }
    return trigrams;
  }

  private async getRules(companyId: number): Promise<ReconciliationRuleRow> {
    if (this.rules) return this.rules;

    const { rows } = await this.client.query<ReconciliationRuleRow>(
      `SELECT * FROM reconciliation_rules
       WHERE company_id = $1 AND is_active = TRUE
       ORDER BY rule_id LIMIT 1`,
      [companyId]
    );

    this.rules = rows[0] ?? {
      rule_id: 0,
      company_id: companyId,
      rule_name: "Default",
      amount_match_weight: 40,
      date_proximity_weight: 30,
      reference_match_weight: 30,
      description_match_weight: 10,
      date_proximity_days: 3,
      auto_match_threshold: 0.7,
      suggest_match_threshold: 0.5,
    };

    return this.rules;
  }

  private async determineStatus(
    confidence: number,
    companyId: number
  ): Promise<ReconciliationStatus> {
    const rules = await this.getRules(companyId);
    if (confidence >= rules.auto_match_threshold) return "MATCHED";
    if (confidence >= rules.suggest_match_threshold) return "SUGGESTED";
    return "UNRECONCILED";
  }
}

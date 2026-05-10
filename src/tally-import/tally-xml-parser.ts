// ============================================================================
// TALLY XML STREAMING PARSER — SAX-based, 2GB+ capable
//
// Strategy: SAX (Simple API for XML) — event-driven, never loads the full
// document into RAM. Processes tags as they are encountered, building only
// one in-memory node at a time. For a 2GB XML file with 100K vouchers,
// peak memory usage is ~2-5 MB (one voucher node + a lookup map).
//
// Dependencies: `sax` npm package — install with `npm install sax @types/sax`
// ============================================================================

import * as sax from "sax";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { TallyLedger, TallyGroup, TallyVoucher, TallyAllLedgerEntry } from "./tally-types";

export type TallyXMLCallback = {
  onLedger: (ledger: TallyLedger) => Promise<void> | void;
  onGroup: (group: TallyGroup) => Promise<void> | void;
  onVoucher: (voucher: TallyVoucher, index: number) => Promise<void> | void;
  onComplete: () => Promise<void> | void;
  onError: (error: Error, voucherIndex?: number) => Promise<void> | void;
  onProgress: (phase: string, count: number) => void;
};

export class TallyXmlParser {
  private parser!: sax.SAXStream;
  private pathStack: string[] = [];
  private currentText = "";
  private voucherIndex = 0;
  private ledgerIndex = 0;
  private groupIndex = 0;

  // Current node being built (one at a time)
  private currentLedger: Partial<TallyLedger> | null = null;
  private currentGroup: Partial<TallyGroup> | null = null;
  private currentVoucher: Partial<TallyVoucher> | null = null;
  private currentLedgerEntry: Partial<TallyAllLedgerEntry> | null = null;
  private ledgerEntries: TallyAllLedgerEntry[] = [];

  private inLedger = false;
  private inGroup = false;
  private inVoucher = false;
  private inLedgerEntry = false;

  // Phase tracking
  private isMastersPhase = true;

  // Deferred tag text capture (for nested elements)
  private captureTag: string | null = null;
  private capturedText = "";

  /**
   * Parse a Tally XML file from a readable stream (file or S3).
   *
   * @param stream    Readable stream from fs.createReadStream or S3.getObject
   * @param callbacks Event handlers for each parsed entity
   * @param options   Configuration (max vouchers to process, etc.)
   */
  async parseStream(
    stream: Readable,
    callbacks: TallyXMLCallback,
    options: { maxVouchers?: number } = {}
  ): Promise<void> {
    const maxVouchers = options.maxVouchers ?? Infinity;

    return new Promise<void>((resolve, reject) => {
      this.parser = sax.createStream(true, {
        trim: true,
        normalize: true,
        lowercase: false,
      });

      // ── SAX Event: Opening Tag ──────────────────────────────────────
      this.parser.on("opentag", (node: sax.Tag) => {
        this.pathStack.push(node.name);
        this.currentText = "";
        const currentPath = this.pathStack.join(".");

        // Detect phase boundary — after </REQUESTDATA> in <MASTER>, switch to vouchers
        if (node.name === "VOUCHER" && this.isMastersPhase) {
          this.isMastersPhase = false;
          callbacks.onProgress("VOUCHERS_START", 0);
        }

        // Masters: LEDGER
        if (node.name === "LEDGER" && this.isMastersPhase) {
          this.inLedger = true;
          this.currentLedger = {};
          this.capturedText = "";
          this.captureTag = null;
        }

        // Masters: GROUP
        if (node.name === "GROUP" && this.isMastersPhase) {
          this.inGroup = true;
          this.currentGroup = {};
        }

        // Vouchers: VOUCHER
        if (node.name === "VOUCHER" && !this.isMastersPhase) {
          this.inVoucher = true;
          this.currentVoucher = {};
          this.ledgerEntries = [];
          this.voucherIndex++;
        }

        // Voucher detail: ALLLEDGERENTRIES.LIST
        if (node.name === "ALLLEDGERENTRIES.LIST" && this.inVoucher) {
          this.inLedgerEntry = true;
          this.currentLedgerEntry = {};
        }

        // Capture specific tag text
        if ((["GUID", "NAME", "PARENT", "GSTIN", "MAILINGNAME", "ADDRESS", "PINCODE", "LEDGERPHONE",
              "VOUCHERTYPENAME", "VOUCHERNUMBER", "DATE", "NARRATION", "EFFECTIVEDATE",
              "VOUCHERKEY", "REFERENCE", "LEDGERNAME", "ISDEEMEDPOSITIVE", "BILLTYPE",
              "REMOTEID", "VOUCHERDATE", "OPENINGBALANCE", "ISBILLWISEON", "ISCOSTCENTRESON",
              "AMOUNT"]
        ).includes(node.name)) {
          this.captureTag = node.name;
          this.capturedText = "";
        }
      });

      // ── SAX Event: Text Content ─────────────────────────────────────
      this.parser.on("text", (text: string) => {
        this.currentText += text;
        if (this.captureTag) {
          this.capturedText += text;
        }
      });

      // ── SAX Event: Closing Tag ──────────────────────────────────────
      this.parser.on("closetag", async (tagName: string) => {
        const text = this.currentText.trim();
        this.pathStack.pop();

        // ── Process captured tag text ──
        this.assignCapturedText(tagName);

        // ── Masters: LEDGER complete ──
        if (tagName === "LEDGER" && this.inLedger && this.currentLedger) {
          this.inLedger = false;
          this.ledgerIndex++;
          try {
            await callbacks.onLedger(this.finalizeLedger(this.currentLedger));
          } catch (err: any) {
            callbacks.onProgress("LEDGER_ERROR", this.ledgerIndex);
          }
          this.currentLedger = null;
          return;
        }

        // ── Masters: GROUP complete ──
        if (tagName === "GROUP" && this.inGroup && this.currentGroup) {
          this.inGroup = false;
          this.groupIndex++;
          try {
            await callbacks.onGroup(this.finalizeGroup(this.currentGroup));
          } catch (err: any) {
            callbacks.onProgress("GROUP_ERROR", this.groupIndex);
          }
          this.currentGroup = null;
          return;
        }

        // ── Voucher: ALLLEDGERENTRIES.LIST complete ──
        if (tagName === "ALLLEDGERENTRIES.LIST" && this.inLedgerEntry && this.currentLedgerEntry) {
          this.inLedgerEntry = false;
          this.ledgerEntries.push(this.finalizeLedgerEntry(this.currentLedgerEntry));
          this.currentLedgerEntry = null;
          return;
        }

        // ── Voucher: VOUCHER complete ──
        if (tagName === "VOUCHER" && this.inVoucher && this.currentVoucher) {
          this.inVoucher = false;
          const voucher = this.finalizeVoucher(this.currentVoucher, this.ledgerEntries);

          if (this.voucherIndex <= maxVouchers) {
            try {
              await callbacks.onVoucher(voucher, this.voucherIndex);
              callbacks.onProgress("VOUCHER", this.voucherIndex);
            } catch (err: any) {
              callbacks.onError(err, this.voucherIndex);
            }
          }

          this.currentVoucher = null;
          this.ledgerEntries = [];
          return;
        }
      });

      // ── SAX Event: End of Stream ────────────────────────────────────
      this.parser.on("end", async () => {
        try {
          await callbacks.onComplete();
        } catch (err: any) {
          reject(err);
          return;
        }
        resolve();
      });

      // ── SAX Event: Parse Error ──────────────────────────────────────
      this.parser.on("error", (err: Error) => {
        // For XML errors, try to continue (resilient parsing)
        // but if it's truly malformed, reject with context
        this.parser.resume();
        if (this.inVoucher) {
          // Within a voucher — this voucher is corrupted, skip it
          callbacks.onError(
            new Error(`XML parse error at voucher #${this.voucherIndex}: ${err.message}`),
            this.voucherIndex
          );
          this.inVoucher = false;
          this.currentVoucher = null;
          this.ledgerEntries = [];
        } else {
          // Outside a voucher — fatal error
          reject(new Error(`Fatal XML parse error: ${err.message}`));
        }
      });

      // ── Pipe the stream ─────────────────────────────────────────────
      stream.pipe(this.parser);
    });
  }

  // =========================================================================
  // PRIVATE — Text Capture & Finalization
  // =========================================================================

  private assignCapturedText(tagName: string): void {
    if (tagName === this.captureTag) {
      const text = this.capturedText.trim();

      if (this.currentLedger && this.inLedger) {
        (this.currentLedger as any)[tagName] = text;
      } else if (this.currentGroup && this.inGroup) {
        (this.currentGroup as any)[tagName] = text;
      } else if (this.currentVoucher && this.inVoucher) {
        (this.currentVoucher as any)[tagName] = text;
      } else if (this.currentLedgerEntry && this.inLedgerEntry) {
        if (tagName === "AMOUNT") {
          this.currentLedgerEntry.AMOUNT = parseTallyAmount(text);
        } else {
          (this.currentLedgerEntry as any)[tagName] = text;
        }
      }

      this.captureTag = null;
      this.capturedText = "";
    }
  }

  private finalizeLedger(raw: Partial<TallyLedger>): TallyLedger {
    return {
      GUID: raw.GUID ?? "",
      NAME: raw.NAME ?? "",
      PARENT: raw.PARENT ?? "Primary",
      OPENINGBALANCE: parseTallyAmount(raw.OPENINGBALANCE as any ?? "0"),
      ISBILLWISEON: raw.ISBILLWISEON,
      ISCOSTCENTRESON: raw.ISCOSTCENTRESON,
      GSTIN: raw.GSTIN,
      MAILINGNAME: raw.MAILINGNAME,
      ADDRESS: raw.ADDRESS,
      PINCODE: raw.PINCODE,
      LEDGERPHONE: raw.LEDGERPHONE,
    };
  }

  private finalizeGroup(raw: Partial<TallyGroup>): TallyGroup {
    return {
      GUID: raw.GUID ?? "",
      NAME: raw.NAME ?? "",
      PARENT: raw.PARENT ?? "Primary",
      ISSUBLEDGER: raw.ISSUBLEDGER,
      GROUPLIST: raw.GROUPLIST,
    };
  }

  private finalizeVoucher(raw: Partial<TallyVoucher>, entries: TallyAllLedgerEntry[]): TallyVoucher {
    return {
      VOUCHERTYPENAME: raw.VOUCHERTYPENAME ?? "Journal",
      VOUCHERNUMBER: raw.VOUCHERNUMBER ?? "",
      GUID: raw.GUID ?? "",
      DATE: raw.DATE ?? "",
      NARRATION: raw.NARRATION ?? "",
      EFFECTIVEDATE: raw.EFFECTIVEDATE,
      VOUCHERKEY: raw.VOUCHERKEY,
      REFERENCE: raw.REFERENCE,
      ALLLEDGERENTRIES: { LIST: entries },
    };
  }

  private finalizeLedgerEntry(raw: Partial<TallyAllLedgerEntry>): TallyAllLedgerEntry {
    return {
      LEDGERNAME: raw.LEDGERNAME ?? "",
      ISDEEMEDPOSITIVE: (raw.ISDEEMEDPOSITIVE as "Yes" | "No") ?? "Yes",
      AMOUNT: raw.AMOUNT ?? 0,
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Parse Tally amount format: "12345.67" or "-500.00" or "1,23,456.78"
 */
function parseTallyAmount(raw: string): number {
  if (!raw) return 0;
  // Remove commas, handle negative sign
  const cleaned = raw.replace(/,/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

/**
 * Parse Tally date format: "01-Apr-2025" → "2025-04-01"
 */
export function parseTallyDate(tallyDate: string): string {
  if (!tallyDate) return new Date().toISOString().split("T")[0];

  const months: Record<string, string> = {
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
    "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
  };

  const match = tallyDate.match(/(\d{1,2})-(\w{3})-(\d{4})/i);
  if (!match) return new Date().toISOString().split("T")[0];

  const day = match[1].padStart(2, "0");
  const month = months[match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase()] ?? "01";
  const year = match[3];
  return `${year}-${month}-${day}`;
}

/**
 * Format an account name for compatibility with our system.
 * Removes special chars, truncates to 200 chars.
 */
export function normalizeAccountName(tallyName: string): string {
  return tallyName.replace(/[^\w\s\-().,&]/g, "").trim().substring(0, 200);
}

/**
 * Generate an account code from Tally GUID or name.
 * Format: TALLY_{first 8 chars of GUID or hash of name}
 */
export function generateTallyAccountCode(name: string, guid?: string): string {
  if (guid && guid.length >= 8) {
    return `TMP_${guid.substring(0, 8).toUpperCase()}`;
  }
  // Simple hash of name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return `TMP_${Math.abs(hash).toString(36).toUpperCase().padStart(8, "0")}`;
}

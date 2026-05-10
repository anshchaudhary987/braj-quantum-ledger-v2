// ============================================================================
// AI EXTRACTION PIPELINE — OCR + LLM Invoice Parsing
//
// Architecture:
//
//  ┌──────────┐     ┌──────────────┐     ┌───────────────────┐
//  │ S3 PDF/  │────▶│  AWS Textract │────▶│  Raw Text +       │
//  │ Image    │     │  (OCR Engine) │     │  Table Blocks     │
//  └──────────┘     └──────────────┘     └────────┬──────────┘
//                                                  │
//                                                  ▼
//  ┌──────────────┐     ┌─────────────────────────────────────┐
//  │  Structured  │◀────│  LLM (Claude / GPT-4o)              │
//  │  JSON Output │     │  Prompt: "Extract invoice fields    │
//  │  + Confidences│    │   from this OCR text into JSON..."  │
//  └──────────────┘     └─────────────────────────────────────┘
//
// Confidence Engine:
//   - Per-field confidence (0-100) estimated by the LLM
//   - Critical fields (GSTIN, total, invoice number) must be ≥ 80%
//     or document is FLAGGED for mandatory human review
//   - Overall ≥ 95% → AUTO_APPROVED
//   - Overall 80-94% → PENDING_REVIEW
//   - Any critical < 80% → FLAGGED
// ============================================================================

import { PoolClient } from "pg";
import { DocumentService } from "./document-service.js";
import {
  OcrExtractionResultRow,
  ExtractedInvoiceData,
  ExtractedLineItem,
  ConfidenceFlag,
  OcrProviderResult,
  LlmExtractionResponse,
  OcrPipelineResult,
  StartExtractionInput,
  SmartMatchResult,
  ReviewDecision,
} from "./ocr-types.js";

export class AiExtractionPipeline {
  constructor(private readonly client: PoolClient) {}

  // =========================================================================
  // PUBLIC — Full Pipeline Orchestration
  // =========================================================================

  /**
   * Run the complete extraction pipeline on a document.
   *
   * Steps:
   *  1. Load document → set QUEUED
   *  2. OCR via Textract → store raw text
   *  3. LLM parsing → structured ExtractedInvoiceData with confidences
   *  4. Smart matching → vendor GSTIN lookup + ledger classification
   *  5. Confidence check → flag critical fields < 80%
   *  6. Create draft voucher (if auto-approved)
   */
  async runFullPipeline(
    input: StartExtractionInput
  ): Promise<OcrPipelineResult> {
    const docService = new DocumentService(this.client);
    const provider = input.ocr_provider ?? "AWS_TEXTRACT";
    const model = input.llm_model ?? "claude-3-sonnet";

    // Step 1: Get document
    const doc = await docService.getDocument(input.document_id, input.tenant_id);
    if (!doc) throw new Error(`Document not found: ${input.document_id}`);

    await docService.updateStatus(input.document_id, "QUEUED", "system");

    // Step 2: OCR Extraction
    await docService.updateStatus(input.document_id, "OCR_IN_PROGRESS", "system");
    const ocrResult = await this.runOcr(doc.s3_url, provider, doc.page_count);
    await this.storeOcrRawResult(input.document_id, ocrResult);

    await this.client.query(
      `UPDATE uploaded_documents
       SET ocr_provider = $2, ocr_job_id = $3, ocr_started_at = now(), ocr_completed_at = now()
       WHERE document_id = $1`,
      [input.document_id, provider, ocrResult.provider_raw_response?.JobId ?? null]
    );
    await docService.updateStatus(input.document_id, "OCR_COMPLETED", "system");

    // Step 3: LLM Parsing
    await docService.updateStatus(input.document_id, "LLM_PARSING", "system");
    const llmResult = await this.runLlmExtraction(ocrResult, model);

    // Step 4: Store extraction results
    const extraction = await this.storeExtraction(input.document_id, doc.tenant_id, llmResult);
    await docService.updateStatus(input.document_id, "EXTRACTION_DONE", "system");

    // Step 5: Smart matching
    await docService.updateStatus(input.document_id, "MATCHING", "system");
    const matchResult = await this.smartMatch(input.document_id, extraction.extraction_id);

    // Step 6: Confidence check
    const reviewDecision = this.determineReviewStatus(
      llmResult.extracted.overall_confidence,
      llmResult.extracted.critical_flags
    );

    await this.client.query(
      `UPDATE ocr_extraction_results
       SET review_status = $2, updated_at = now()
       WHERE extraction_id = $1`,
      [extraction.extraction_id, reviewDecision]
    );

    await docService.updateStatus(
      input.document_id,
      reviewDecision === "AUTO_APPROVED" ? "DRAFT_READY" : "EXTRACTION_DONE",
      "system"
    );

    return {
      document_id: input.document_id,
      extraction_id: extraction.extraction_id,
      extracted: llmResult.extracted,
      matching: matchResult,
      draft_transaction_id: null, // created separately via route
      review_status: reviewDecision,
    };
  }

  // =========================================================================
  // OCR ENGINE — AWS Textract (Synchronous for single-page / small docs)
  // For multi-page PDFs >5 pages, use async Textract APIs with SNS notifications.
  // =========================================================================

  /**
   * Call AWS Textract to extract raw text from the document.
   *
   * In production, this would use @aws-sdk/client-textract.
   * For now, this provides the integration logic and data flow.
   */
  async runOcr(
    s3Url: string,
    provider: string,
    _pageCount: number
  ): Promise<OcrProviderResult> {
    const startTime = Date.now();

    if (provider === "AWS_TEXTRACT") {
      // -- Actual AWS Textract call (pseudo-code for integration) --
      //
      // import { TextractClient, AnalyzeDocumentCommand } from "@aws-sdk/client-textract";
      // const textract = new TextractClient({ region: process.env.AWS_REGION });
      //
      // const command = new AnalyzeDocumentCommand({
      //   Document: { S3Object: { Bucket: bucket, Name: key } },
      //   FeatureTypes: ["TABLES", "FORMS"],
      // });
      // const response = await textract.send(command);
      //
      // -- Parse blocks into text_blocks and table_blocks --
      // const blocks = response.Blocks ?? [];
      // const textBlocks = blocks
      //   .filter(b => b.BlockType === "LINE")
      //   .map(b => ({ text: b.Text ?? "", confidence: b.Confidence ?? 0, block_type: "LINE" }));
      //
      // const tableBlocks = parseTables(blocks); // custom: group CELL blocks by TABLE

      // Placeholder for the actual integration:
      const mockResult: OcrProviderResult = {
        raw_text: await this.simulateTextractCall(s3Url),
        pages: [],
        provider_raw_response: {
          provider,
          s3_url: s3Url,
          status: "SUCCEEDED",
        },
        processing_time_ms: Date.now() - startTime,
      };

      // Track cost
      await this.client.query(
        `UPDATE uploaded_documents
         SET ocr_cost_estimate = $2, processing_time_ms = $3
         WHERE s3_url = $1`,
        [s3Url, 0.0015, mockResult.processing_time_ms]
      );

      return mockResult;
    }

    // Google Document AI
    if (provider === "GOOGLE_DOC_AI") {
      // -- GCP Document AI (pseudo-code) --
      // const { DocumentProcessorServiceClient } = require("@google-cloud/documentai");
      // const client = new DocumentProcessorServiceClient();
      // const [result] = await client.processDocument({ name: processorPath, rawDocument: { content, mimeType } });
      // Parse result.document.text, result.document.pages, result.document.entities

      const mockResult: OcrProviderResult = {
        raw_text: await this.simulateTextractCall(s3Url),
        pages: [],
        provider_raw_response: { provider, status: "SUCCEEDED" },
        processing_time_ms: Date.now() - startTime,
      };
      return mockResult;
    }

    throw new Error(`Unsupported OCR provider: ${provider}`);
  }

  // =========================================================================
  // LLM EXTRACTION — Send OCR text to Claude/GPT with structured prompt
  // =========================================================================

  /**
   * Send raw OCR text to an LLM with a carefully engineered prompt
   * that instructs it to return structured JSON with confidence scores.
   */
  async runLlmExtraction(
    ocrResult: OcrProviderResult,
    model: string
  ): Promise<LlmExtractionResponse> {
    const startTime = Date.now();

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(ocrResult.raw_text);

    // -- Actual LLM call (pseudo-code) --
    //
    // import Anthropic from "@anthropic-ai/sdk";
    // const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // const response = await anthropic.messages.create({
    //   model: "claude-3-sonnet-20240229",
    //   max_tokens: 4096,
    //   temperature: 0,
    //   system: systemPrompt,
    //   messages: [{ role: "user", content: userPrompt }],
    // });
    //
    // For OpenAI:
    // import OpenAI from "openai";
    // const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // const response = await openai.chat.completions.create({
    //   model: "gpt-4o",
    //   max_tokens: 4096,
    //   temperature: 0,
    //   messages: [
    //     { role: "system", content: systemPrompt },
    //     { role: "user", content: userPrompt },
    //   ],
    //   response_format: { type: "json_object" },
    // });

    // Parse the LLM response into ExtractedInvoiceData
    // const rawJson = JSON.parse(response.content[0].text);
    // const extracted = this.validateAndNormalize(rawJson);

    // Placeholder
    const extracted = await this.simulateLlmParse(ocrResult.raw_text);

    // Track token usage
    const promptTokens = Math.ceil(systemPrompt.length / 3.5) + Math.ceil(userPrompt.length / 3.5);
    const completionTokens = Math.ceil(JSON.stringify(extracted).length / 3.5);

    await this.client.query(
      `UPDATE uploaded_documents
       SET ocr_tokens_used = COALESCE(ocr_tokens_used, 0) + $2
       WHERE s3_url = $1`,
      [ocrResult.provider_raw_response?.["s3_url"] ?? "", promptTokens + completionTokens]
    );

    return {
      extracted,
      model_used: model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      raw_response: { model, status: "success" },
      processing_time_ms: Date.now() - startTime,
    };
  }

  // =========================================================================
  // CONFIDENCE & REVIEW LOGIC
  // =========================================================================

  /**
   * Determine review status based on confidence thresholds.
   *
   * Rules:
   *   overall_confidence ≥ 95%  AND no critical flags → AUTO_APPROVED
   *   overall_confidence ≥ 80%  AND no critical flags → PENDING_REVIEW
   *   Any critical flag (GSTIN/total/inv# < 80%)      → FLAGGED
   */
  determineReviewStatus(
    overallConfidence: number,
    criticalFlags: ConfidenceFlag[]
  ): ReviewDecision {
    if (criticalFlags.length > 0) {
      return "FLAGGED";
    }
    if (overallConfidence >= 95) {
      return "AUTO_APPROVED";
    }
    return "PENDING_REVIEW";
  }

  // =========================================================================
  // SMART MATCHING — Vendor GSTIN + Expense Ledger
  // =========================================================================

  /**
   * Run vendor matching and expense ledger classification via DB functions.
   */
  async smartMatch(
    documentId: number,
    extractionId: number
  ): Promise<SmartMatchResult> {
    // Vendor matching via DB function
    const { rows: vendorRows } = await this.client.query<{
      matched_id: string;
      matched_score: string;
      is_new: boolean;
    }>(
      `SELECT * FROM match_vendor_from_extraction($1)`,
      [extractionId]
    );

    const vendorMatch = vendorRows[0];
    const matchedVendorId = vendorMatch?.matched_id ? Number(vendorMatch.matched_id) : null;
    const matchedVendorScore = vendorMatch ? Number(vendorMatch.matched_score) : 0;
    const isNewVendor = vendorMatch?.is_new ?? true;

    // Ledger classification for the first line item
    const { rows: extRows } = await this.client.query<{ line_items: ExtractedLineItem[] }>(
      `SELECT line_items FROM ocr_extraction_results WHERE extraction_id = $1`,
      [extractionId]
    );

    let suggestedLedgerId: number | null = null;
    let suggestedLedgerName: string | null = null;
    let suggestedLedgerConfidence: number = 0;

    const items = extRows[0]?.line_items ?? [];
    if (items.length > 0) {
      const itemDesc = items[0].item_name + " " + (items[0].description ?? "");
      const { rows: ledgerRows } = await this.client.query<{
        account_id: string;
        account_name: string;
        confidence: string;
      }>(
        `SELECT * FROM classify_expense_ledger($1, NULL)`,
        [itemDesc]
      );
      if (ledgerRows.length > 0 && ledgerRows[0].account_id) {
        suggestedLedgerId = Number(ledgerRows[0].account_id);
        suggestedLedgerName = ledgerRows[0].account_name;
        suggestedLedgerConfidence = Number(ledgerRows[0].confidence);
      }
    }

    // Update extraction row with match results
    await this.client.query(
      `UPDATE ocr_extraction_results
       SET matched_vendor_id = $2, matched_vendor_score = $3,
           is_new_vendor = $4,
           suggested_ledger_id = $5, suggested_ledger_name = $6,
           suggested_ledger_confidence = $7,
           updated_at = now()
       WHERE extraction_id = $1`,
      [
        extractionId, matchedVendorId, matchedVendorScore,
        isNewVendor,
        suggestedLedgerId, suggestedLedgerName, suggestedLedgerConfidence,
      ]
    );

    return {
      matched_vendor_id: matchedVendorId,
      matched_vendor_score: matchedVendorScore,
      is_new_vendor: isNewVendor,
      suggested_ledger_id: suggestedLedgerId,
      suggested_ledger_name: suggestedLedgerName,
      suggested_ledger_confidence: suggestedLedgerConfidence,
    };
  }

  // =========================================================================
  // DATA PERSISTENCE
  // =========================================================================

  private async storeOcrRawResult(
    documentId: number,
    ocrResult: OcrProviderResult
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO ocr_raw_results (document_id, page_number, raw_text, text_blocks, table_blocks, provider_response)
       VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (document_id, page_number) DO UPDATE SET
         raw_text = EXCLUDED.raw_text,
         text_blocks = EXCLUDED.text_blocks,
         table_blocks = EXCLUDED.table_blocks,
         provider_response = EXCLUDED.provider_response`,
      [
        documentId,
        ocrResult.raw_text,
        JSON.stringify(ocrResult.pages?.[0]?.text_blocks ?? []),
        JSON.stringify(ocrResult.pages?.[0]?.tables ?? []),
        JSON.stringify(ocrResult.provider_raw_response),
      ]
    );
  }

  private async storeExtraction(
    documentId: number,
    tenantId: string,
    llmResult: LlmExtractionResponse
  ): Promise<OcrExtractionResultRow> {
    const e = llmResult.extracted;

    const { rows } = await this.client.query<OcrExtractionResultRow>(
      `INSERT INTO ocr_extraction_results (
         document_id, tenant_id,
         invoice_number, invoice_number_confidence,
         invoice_date, invoice_date_confidence,
         due_date, due_date_confidence,
         vendor_gstin, vendor_gstin_confidence,
         vendor_name, vendor_name_confidence,
         vendor_address, vendor_address_confidence,
         vendor_phone,
         sub_total, sub_total_confidence,
         total_tax, total_tax_confidence,
         gross_total, gross_total_confidence,
         round_off, amount_in_words,
         cgst_amount, cgst_amount_confidence,
         sgst_amount, sgst_amount_confidence,
         igst_amount, igst_amount_confidence,
         cess_amount, cess_amount_confidence,
         place_of_supply, place_of_supply_confidence,
         line_items, line_items_avg_confidence,
         overall_confidence, critical_flags,
         llm_model, llm_prompt_tokens, llm_completion_tokens, llm_raw_response
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
       ON CONFLICT (document_id) DO UPDATE SET
         invoice_number = EXCLUDED.invoice_number,
         invoice_number_confidence = EXCLUDED.invoice_number_confidence,
         invoice_date = EXCLUDED.invoice_date,
         invoice_date_confidence = EXCLUDED.invoice_date_confidence,
         due_date = EXCLUDED.due_date,
         vendor_gstin = EXCLUDED.vendor_gstin,
         vendor_gstin_confidence = EXCLUDED.vendor_gstin_confidence,
         vendor_name = EXCLUDED.vendor_name,
         vendor_name_confidence = EXCLUDED.vendor_name_confidence,
         vendor_address = EXCLUDED.vendor_address,
         sub_total = EXCLUDED.sub_total, sub_total_confidence = EXCLUDED.sub_total_confidence,
         total_tax = EXCLUDED.total_tax, total_tax_confidence = EXCLUDED.total_tax_confidence,
         gross_total = EXCLUDED.gross_total, gross_total_confidence = EXCLUDED.gross_total_confidence,
         round_off = EXCLUDED.round_off, amount_in_words = EXCLUDED.amount_in_words,
         cgst_amount = EXCLUDED.cgst_amount, cgst_amount_confidence = EXCLUDED.cgst_amount_confidence,
         sgst_amount = EXCLUDED.sgst_amount, sgst_amount_confidence = EXCLUDED.sgst_amount_confidence,
         igst_amount = EXCLUDED.igst_amount, igst_amount_confidence = EXCLUDED.igst_amount_confidence,
         cess_amount = EXCLUDED.cess_amount, cess_amount_confidence = EXCLUDED.cess_amount_confidence,
         place_of_supply = EXCLUDED.place_of_supply,
         line_items = EXCLUDED.line_items, line_items_avg_confidence = EXCLUDED.line_items_avg_confidence,
         overall_confidence = EXCLUDED.overall_confidence, critical_flags = EXCLUDED.critical_flags,
         llm_model = EXCLUDED.llm_model,
         llm_prompt_tokens = EXCLUDED.llm_prompt_tokens,
         llm_completion_tokens = EXCLUDED.llm_completion_tokens,
         llm_raw_response = EXCLUDED.llm_raw_response,
         updated_at = now()`,
      [
        documentId, tenantId,
        e.invoice_number, e.invoice_number_confidence,
        e.invoice_date, e.invoice_date_confidence,
        e.due_date, e.due_date_confidence,
        e.vendor_gstin, e.vendor_gstin_confidence,
        e.vendor_name, e.vendor_name_confidence,
        e.vendor_address, e.vendor_address_confidence,
        e.vendor_phone,
        e.sub_total, e.sub_total_confidence,
        e.total_tax, e.total_tax_confidence,
        e.gross_total, e.gross_total_confidence,
        e.round_off, e.amount_in_words,
        e.cgst_amount, e.cgst_amount_confidence,
        e.sgst_amount, e.sgst_amount_confidence,
        e.igst_amount, e.igst_amount_confidence,
        e.cess_amount, e.cess_amount_confidence,
        e.place_of_supply, e.place_of_supply_confidence,
        JSON.stringify(e.line_items), e.line_items_avg_confidence,
        e.overall_confidence, JSON.stringify(e.critical_flags),
        llmResult.model_used, llmResult.prompt_tokens, llmResult.completion_tokens,
        JSON.stringify(llmResult.raw_response),
      ]
    );

    return rows[0];
  }

  // =========================================================================
  // LLM PROMPT ENGINEERING
  // =========================================================================

  private buildSystemPrompt(): string {
    return `You are an expert invoice data extraction system for Indian GST-compliant invoices.
Your task is to extract structured fields from OCR text of purchase invoices/receipts.

CRITICAL INSTRUCTIONS:
1. Return a valid JSON object matching the schema exactly. No markdown, no extra text.
2. For EVERY extracted field, provide a confidence_score from 0 to 100.
   - 100 = exact match visible in text
   - 80-99 = inferred with high certainty (e.g., rounding differences)
   - 50-79 = ambiguous, multiple candidates possible
   - < 50 = guess based on context
3. GSTIN validation: Must be 15 characters (2 digits + 5 letters + 4 digits + 1 digit + 1 letter/digit + 'Z' + 1 digit)
4. Date format: Return as YYYY-MM-DD. If unclear day/month, flag low confidence.
5. Amount fields: All amounts should be NUMERIC (not strings). Round to 2 decimal places.
6. Line items: Extract each row from the invoice table. Each item must have: sl_no, item_name, description, hsn_code (if visible), quantity, unit, rate, taxable_value, igst_amount, cgst_amount, sgst_amount, cess_amount, total, confidence.
7. Tax types: Indian GST uses CGST+SGST for intra-state and IGST for inter-state. If one pair appears, the others should be 0.
8. If a field is NOT present in the invoice, set its value to null and confidence to 0.
9. Ensure math validation: sub_total + total_tax should approximately equal gross_total (allow for rounding).`;
  }

  private buildUserPrompt(rawText: string): string {
    return `Extract all invoice fields from the following OCR text. Return ONLY valid JSON:

--- BEGIN OCR TEXT ---
${rawText}
--- END OCR TEXT ---

Return this JSON schema:
{
  "invoice_number": string | null,
  "invoice_number_confidence": number,
  "invoice_date": "YYYY-MM-DD" | null,
  "invoice_date_confidence": number,
  "due_date": "YYYY-MM-DD" | null,
  "due_date_confidence": number,
  "vendor_gstin": string | null,
  "vendor_gstin_confidence": number,
  "vendor_name": string | null,
  "vendor_name_confidence": number,
  "vendor_address": string | null,
  "vendor_address_confidence": number,
  "vendor_phone": string | null,
  "sub_total": number | null,
  "sub_total_confidence": number,
  "total_tax": number | null,
  "total_tax_confidence": number,
  "gross_total": number | null,
  "gross_total_confidence": number,
  "round_off": number | null,
  "amount_in_words": string | null,
  "cgst_amount": number,
  "cgst_amount_confidence": number,
  "sgst_amount": number,
  "sgst_amount_confidence": number,
  "igst_amount": number,
  "igst_amount_confidence": number,
  "cess_amount": number,
  "cess_amount_confidence": number,
  "place_of_supply": string | null,
  "place_of_supply_confidence": number,
  "line_items": [
    {
      "sl_no": number,
      "item_name": string,
      "description": string | null,
      "hsn_code": string | null,
      "quantity": number,
      "unit": string | null,
      "rate": number,
      "taxable_value": number,
      "igst_amount": number,
      "cgst_amount": number,
      "sgst_amount": number,
      "cess_amount": number,
      "total": number,
      "confidence": number
    }
  ],
  "line_items_avg_confidence": number,
  "overall_confidence": number,
  "critical_flags": [
    { "field": string, "confidence": number, "reason": string }
  ]
}`;
  }

  private validateAndNormalize(raw: Record<string, unknown>): ExtractedInvoiceData {
    return {
      invoice_number: raw.invoice_number as string | null ?? null,
      invoice_number_confidence: Number(raw.invoice_number_confidence ?? 0),
      invoice_date: raw.invoice_date as string | null ?? null,
      invoice_date_confidence: Number(raw.invoice_date_confidence ?? 0),
      due_date: raw.due_date as string | null ?? null,
      due_date_confidence: Number(raw.due_date_confidence ?? 0),
      vendor_gstin: raw.vendor_gstin as string | null ?? null,
      vendor_gstin_confidence: Number(raw.vendor_gstin_confidence ?? 0),
      vendor_name: raw.vendor_name as string | null ?? null,
      vendor_name_confidence: Number(raw.vendor_name_confidence ?? 0),
      vendor_address: raw.vendor_address as string | null ?? null,
      vendor_address_confidence: Number(raw.vendor_address_confidence ?? 0),
      vendor_phone: raw.vendor_phone as string | null ?? null,
      sub_total: raw.sub_total != null ? Number(raw.sub_total) : null,
      sub_total_confidence: Number(raw.sub_total_confidence ?? 0),
      total_tax: raw.total_tax != null ? Number(raw.total_tax) : null,
      total_tax_confidence: Number(raw.total_tax_confidence ?? 0),
      gross_total: raw.gross_total != null ? Number(raw.gross_total) : null,
      gross_total_confidence: Number(raw.gross_total_confidence ?? 0),
      round_off: raw.round_off != null ? Number(raw.round_off) : null,
      amount_in_words: raw.amount_in_words as string | null ?? null,
      cgst_amount: Number(raw.cgst_amount ?? 0),
      cgst_amount_confidence: Number(raw.cgst_amount_confidence ?? 0),
      sgst_amount: Number(raw.sgst_amount ?? 0),
      sgst_amount_confidence: Number(raw.sgst_amount_confidence ?? 0),
      igst_amount: Number(raw.igst_amount ?? 0),
      igst_amount_confidence: Number(raw.igst_amount_confidence ?? 0),
      cess_amount: Number(raw.cess_amount ?? 0),
      cess_amount_confidence: Number(raw.cess_amount_confidence ?? 0),
      place_of_supply: raw.place_of_supply as string | null ?? null,
      place_of_supply_confidence: Number(raw.place_of_supply_confidence ?? 0),
      line_items: (raw.line_items as ExtractedLineItem[]) ?? [],
      line_items_avg_confidence: Number(raw.line_items_avg_confidence ?? 0),
      overall_confidence: Number(raw.overall_confidence ?? 0),
      critical_flags: (raw.critical_flags as ConfidenceFlag[]) ?? [],
    };
  }

  // =========================================================================
  // PLACEHOLDER SIMULATIONS (replace with actual API integrations)
  // =========================================================================

  private async simulateTextractCall(_s3Url: string): Promise<string> {
    // In production: actual Textract API call
    return "INVOICE\nABC Traders Pvt Ltd\nGSTIN: 27AABCT1234Q1Z5\nInvoice No: INV-2025-00123\nDate: 15/04/2025\n\nSl  Description        HSN    Qty  Rate    Amount\n1   Dell Monitor 24\"   LED  8471  2    12000   24000\n2   Wireless Keyboard       8471  3    1500    4500\n\nSubtotal: 28500\nCGST @9%: 2565\nSGST @9%: 2565\nGrand Total: 33630\n\nAmount in words: Thirty three thousand six hundred thirty only";
  }

  private async simulateLlmParse(rawText: string): Promise<ExtractedInvoiceData> {
    // In production: actual LLM API call (Anthropic / OpenAI)
    // Return mock for now
    return {
      invoice_number: "INV-2025-00123",
      invoice_number_confidence: 98,
      invoice_date: "2025-04-15",
      invoice_date_confidence: 95,
      due_date: null,
      due_date_confidence: 0,
      vendor_gstin: "27AABCT1234Q1Z5",
      vendor_gstin_confidence: 92,
      vendor_name: "ABC Traders Pvt Ltd",
      vendor_name_confidence: 95,
      vendor_address: null,
      vendor_address_confidence: 0,
      vendor_phone: null,
      sub_total: 28500,
      sub_total_confidence: 90,
      total_tax: 5130,
      total_tax_confidence: 88,
      gross_total: 33630,
      gross_total_confidence: 95,
      round_off: null,
      amount_in_words: "Thirty three thousand six hundred thirty only",
      cgst_amount: 2565,
      cgst_amount_confidence: 90,
      sgst_amount: 2565,
      sgst_amount_confidence: 90,
      igst_amount: 0,
      igst_amount_confidence: 100,
      cess_amount: 0,
      cess_amount_confidence: 100,
      place_of_supply: "27",
      place_of_supply_confidence: 60,
      line_items: [
        { sl_no: 1, item_name: "Dell Monitor 24 LED", hsn_code: "8471", quantity: 2, unit: "NOS", rate: 12000, taxable_value: 24000, igst_amount: 0, cgst_amount: 2160, sgst_amount: 2160, cess_amount: 0, total: 28320, confidence: 85 },
        { sl_no: 2, item_name: "Wireless Keyboard", hsn_code: "8471", quantity: 3, unit: "NOS", rate: 1500, taxable_value: 4500, igst_amount: 0, cgst_amount: 405, sgst_amount: 405, cess_amount: 0, total: 5310, confidence: 82 },
      ],
      line_items_avg_confidence: 83.5,
      overall_confidence: 88.1,
      critical_flags: [],
    };
  }
}

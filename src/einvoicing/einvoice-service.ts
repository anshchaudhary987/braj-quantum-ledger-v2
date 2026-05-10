// ============================================================================
// E-INVOICE (IRP) & E-WAY BILL (NIC) — Core Orchestration Service
//
// Responsibilities:
//  1. Generate e-invoice: draft → build INV-01 → queue to GSP → IRP response
//  2. Cancel e-invoice: validate 24h window → queue cancellation
//  3. Process retry queue items: dequeues, calls GSP, handles response
//  4. Manage e-way bill lifecycle: generate, extend, cancel
//  5. Status transitions with audit trail
// ============================================================================

import { PoolClient } from "pg";
import {
  EInvoiceDetailRow,
  EwayBillDetailRow,
  EInvoiceStatus,
  EwayBillStatus,
  GenerateEinvoiceInput,
  GenerateEwayBillInput,
  CancelEinvoiceInput,
  DistanceCalcResult,
  RetryQueueRow,
} from "./einvoice-types.js";
import { Inv01PayloadMapper } from "./payload-mapper.js";
import { DistanceService } from "./distance-service.js";
import { GspAuthService } from "./gsp-auth.js";

export class EinvoiceService {
  constructor(private readonly client: PoolClient) {}

  // =========================================================================
  // E-INVOICE GENERATION
  // =========================================================================

  /**
   * Create a draft e-invoice record, build INV-01 payload, and enqueue to
   * the retry queue for automatic push to IRP via GSP.
   *
   * Returns { e_invoice_id, status } — status will be 'PENDING' meaning
   * the invoice is queued for batch submission.
   */
  async generateEinvoice(input: GenerateEinvoiceInput): Promise<{
    e_invoice_id: number;
    status: EInvoiceStatus;
  }> {
    // Step 1: Validate — ensure no duplicate e-invoice for this invoice_number
    const existing = await this.client.query<EInvoiceDetailRow>(
      `SELECT e_invoice_id, status FROM e_invoice_details
       WHERE gst_registration_id = $1 AND invoice_number = $2 AND tenant_id = $3`,
      [input.gst_registration_id, input.invoice_number, input.tenant_id]
    );
    if (existing.rows.length > 0) {
      const ex = existing.rows[0];
      if (ex.status === "GENERATED") {
        throw new Error(`E-Invoice already generated for invoice ${input.invoice_number}. IRN: ${ex.irn}`);
      }
      // Re-submit if previously FAILED
      if (ex.status === "FAILED") {
        return { e_invoice_id: ex.e_invoice_id, status: await this.reenqueue(ex.e_invoice_id, input.tenant_id) };
      }
    }

    // Step 2: Build the INV-01 payload
    const mapper = new Inv01PayloadMapper(this.client);
    const payload = await mapper.buildEinvoicePayload(
      input.transaction_id,
      input.invoice_number,
      input.invoice_date,
      input.supply_type,
      input.is_reverse_charge ?? false,
      input.gst_registration_id,
      input.tenant_id
    );

    // Step 3: Resolve GSP credential for this GSTIN
    const gspCredId = await this.resolveGspCredential(input.tenant_id, input.gst_registration_id);

    // Step 4: Insert e_invoice_details row (DRAFT → immediately transition to PENDING)
    const { rows } = await this.client.query<EInvoiceDetailRow>(
      `INSERT INTO e_invoice_details (
         transaction_id, tenant_id, gst_registration_id,
         invoice_number, invoice_date, supply_type,
         is_reverse_charge, request_payload, status,
         status_history
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT',
                jsonb_build_array(jsonb_build_object(
                  'status', 'DRAFT', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', 'system'
                )))
       RETURNING *`,
      [
        input.transaction_id,
        input.tenant_id,
        input.gst_registration_id,
        input.invoice_number,
        input.invoice_date,
        input.supply_type,
        input.is_reverse_charge ?? false,
        JSON.stringify(payload),
      ]
    );
    const einvoice = rows[0];

    // Step 5: Transition to PENDING + enqueue to retry queue
    await this.transitionStatus(einvoice.e_invoice_id, "PENDING", "system", input.tenant_id);

    await this.enqueueRetry({
      entity_type: "E_INVOICE",
      entity_id: einvoice.e_invoice_id,
      operation: "GENERATE",
      tenant_id: input.tenant_id,
      gsp_credential_id: gspCredId,
      endpoint_path: "/api/v1/invoice/generate",
      payload: payload as unknown as Record<string, unknown>,
    });

    return { e_invoice_id: einvoice.e_invoice_id, status: "PENDING" };
  }

  // =========================================================================
  // E-INVOICE CANCELLATION (with 24-hour window guard)
  // =========================================================================

  /**
   * Cancel an e-invoice. Calls the DB-level 24h guard, then enqueues
   * the cancellation IRP API call.
   *
   * If force_credit_note is true or the 24h window has expired, the system
   * marks the e-invoice as EXPIRED and returns a recommendation to issue
   * a Credit Note through the accounting module.
   */
  async cancelEinvoice(input: CancelEinvoiceInput): Promise<{
    e_invoice_id: number;
    action: "CANCELLED" | "EXPIRED" | "CREDIT_NOTE_RECOMMENDED";
    reason: string;
    credit_note_required?: boolean;
  }> {
    const { rows: einvRows } = await this.client.query<EInvoiceDetailRow>(
      `SELECT * FROM e_invoice_details WHERE e_invoice_id = $1 AND tenant_id = $2`,
      [input.e_invoice_id, input.tenant_id]
    );
    const einv = einvRows[0];
    if (!einv) {
      throw new Error(`E-Invoice not found: ${input.e_invoice_id}`);
    }

    // Step 1: Check the 24-hour window via DB function
    const { rows } = await this.client.query<{
      can_cancel: boolean;
      reason: string;
      ack_dt: string;
      hours_elapsed: string;
    }>(
      `SELECT * FROM can_cancel_einvoice($1, $2)`,
      [input.e_invoice_id, new Date().toISOString()]
    );
    const check = rows[0];

    if (!check) {
      throw new Error(`E-Invoice not found: ${input.e_invoice_id}`);
    }

    if (input.force_credit_note || !check.can_cancel) {
      // 24h window expired or force: mark as EXPIRED
      await this.client.query(
        `UPDATE e_invoice_details
         SET status = 'EXPIRED',
             status_history = status_history || jsonb_build_object(
               'status', 'EXPIRED', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'actor', 'system'
             ),
              cancelled_reason = $2,
              cancelled_at = now()
          WHERE e_invoice_id = $1 AND tenant_id = $3`,
        [input.e_invoice_id, input.reason, input.tenant_id]
      );

      return {
        e_invoice_id: input.e_invoice_id,
        action: "CREDIT_NOTE_RECOMMENDED",
        reason: check.reason,
        credit_note_required: true,
      };
    }

    // Step 2: Within 24h window — enqueue cancellation to IRP
    const gspCredId = await this.resolveGspCredential(einv.tenant_id, einv.gst_registration_id);

    await this.enqueueRetry({
      entity_type: "E_INVOICE",
      entity_id: input.e_invoice_id,
      operation: "CANCEL",
      tenant_id: einv.tenant_id,
      gsp_credential_id: gspCredId,
      endpoint_path: "/api/v1/invoice/cancel",
      payload: { irn: einv.irn, reason: input.reason },
    });

    await this.transitionStatus(input.e_invoice_id, "PENDING", "system", input.tenant_id);

    return {
      e_invoice_id: input.e_invoice_id,
      action: "CANCELLED",
      reason: check.reason,
    };
  }

  // =========================================================================
  // E-WAY BILL GENERATION
  // =========================================================================

  /**
   * Generate an e-way bill. Automatically calculates distance if ROAD.
   */
  async generateEwayBill(input: GenerateEwayBillInput): Promise<{
    eway_bill_id: number;
    status: EwayBillStatus;
    distance: DistanceCalcResult | null;
  }> {
    // Step 1: Auto-calculate distance
    let distanceResult: DistanceCalcResult | null = null;

    if (input.transport_mode === "ROAD") {
      const distService = new DistanceService(this.client);
      distanceResult = await distService.calculate(input.dispatch_from_pin, input.ship_to_pin);
    }

    let transactionId = input.transaction_id ?? null;
    let gstRegistrationId = input.gst_registration_id;
    let documentNumber = "";
    let documentDate = new Date().toISOString().split("T")[0];

    if (input.e_invoice_id) {
      const einvoice = await this.getEinvoiceStatus(input.e_invoice_id, input.tenant_id);
      if (!einvoice) throw new Error(`E-Invoice not found: ${input.e_invoice_id}`);
      if (transactionId && transactionId !== einvoice.transaction_id) {
        throw new Error("E-Way Bill transaction_id does not match the linked e-invoice.");
      }
      if (gstRegistrationId !== einvoice.gst_registration_id) {
        throw new Error("E-Way Bill GST registration does not match the linked e-invoice.");
      }
      transactionId = einvoice.transaction_id;
      gstRegistrationId = einvoice.gst_registration_id;
      documentNumber = einvoice.invoice_number;
      documentDate = einvoice.invoice_date;
    }

    if (!transactionId) {
      throw new Error("E-Way Bill generation requires a transaction_id or linked e_invoice_id.");
    }

    // Step 2: Build E-Way Bill payload
    const mapper = new Inv01PayloadMapper(this.client);
    const payload = await mapper.buildEwayBillPayload({
      transactionId,
      tenantId: input.tenant_id,
      gstRegistrationId,
      supplyType: input.supply_type ?? "B2B",
      subSupplyType: "SUPPLY",
      documentType: "INV",
      documentNumber,
      documentDate,
      fromPincode: input.dispatch_from_pin,
      toPincode: input.ship_to_pin,
      transportMode: input.transport_mode,
      vehicleNumber: input.vehicle_number,
      transporterId: input.transporter_id,
      distanceKm: distanceResult?.distance_km ?? 0,
    });

    // Step 3: Resolve GSP credential
    const gspCredId = await this.resolveGspCredential(input.tenant_id, gstRegistrationId);

    // Step 4: Insert eway_bill_details row
    const { rows } = await this.client.query<EwayBillDetailRow>(
      `INSERT INTO eway_bill_details (
         e_invoice_id, transaction_id, tenant_id, gst_registration_id,
         supply_type, sub_supply_type, document_type, document_number, document_date,
         dispatch_from_pin, ship_to_pin,
         approx_distance_km, distance_source, distance_calc_response,
         transport_mode, vehicle_number, transporter_id,
         request_payload, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'QUEUED')
       RETURNING *`,
      [
        input.e_invoice_id ?? null,
        transactionId,
        input.tenant_id,
        gstRegistrationId,
        input.supply_type ?? "B2B",
        "SUPPLY",
        "INV",
        payload.docNo,
        payload.docDate,
        input.dispatch_from_pin,
        input.ship_to_pin,
        distanceResult?.distance_km ?? null,
        distanceResult?.source ?? "MANUAL",
        distanceResult?.raw_response ? JSON.stringify(distanceResult.raw_response) : null,
        input.transport_mode,
        input.vehicle_number ?? null,
        input.transporter_id ?? null,
        JSON.stringify(payload),
      ]
    );
    const ewb = rows[0];

    // Step 5: Enqueue
    await this.enqueueRetry({
      entity_type: "EWAY_BILL",
      entity_id: ewb.eway_bill_id,
      operation: "GENERATE",
      tenant_id: input.tenant_id,
      gsp_credential_id: gspCredId,
      endpoint_path: "/api/v1/ewaybill/generate",
      payload: payload as unknown as Record<string, unknown>,
    });

    return { eway_bill_id: ewb.eway_bill_id, status: "QUEUED", distance: distanceResult };
  }

  // =========================================================================
  // RETRY QUEUE — PROCESS A SINGLE ITEM
  // =========================================================================

  /**
   * Process a single retry queue item. Called by the retry worker.
   *
   * 1. Gets GSP token
   * 2. POSTs to GSP endpoint
   * 3. Handles response (success, retryable error, permanent failure)
   * 4. Updates e_invoice_details / eway_bill_details accordingly
   */
  async processRetryItem(retryItem: RetryQueueRow): Promise<void> {
    const { retry_id, entity_type, entity_id, operation, tenant_id, gsp_credential_id, endpoint_path, payload } = retryItem;

    // Mark IN_PROGRESS
    await this.client.query(
      `UPDATE api_retry_queue
       SET status = 'IN_PROGRESS', attempt_count = attempt_count + 1,
           last_attempted_at = now(), updated_at = now()
       WHERE retry_id = $1 AND tenant_id = $2 AND status = 'QUEUED'`,
      [retry_id, tenant_id]
    );

    try {
      // Get GSP auth token
      if (!gsp_credential_id) throw new Error("No GSP credential linked");
      const token = await GspAuthService.getToken(gsp_credential_id);

      // Call GSP endpoint
      const { rows: credRows } = await this.client.query<{ base_url: string }>(
        `SELECT base_url FROM gsp_credentials
         WHERE gsp_credential_id = $1 AND tenant_id = $2 AND is_active = TRUE`,
        [gsp_credential_id, tenant_id]
      );
      const baseUrl = credRows[0]?.base_url ?? "";
      if (!baseUrl) throw new Error("No active GSP credential URL found for retry item.");

      const res = await fetch(`${baseUrl}${endpoint_path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const responseBody = (await res.json().catch(() => ({ error: res.statusText }))) as Record<string, unknown>;

      if (res.status === 401) {
        // Token expired — invalidate and retry
        await GspAuthService.invalidateToken(gsp_credential_id);
        throw new RetryableError("GSP token expired — will retry with fresh token");
      }

      if (res.status >= 500) {
        // Server error — retry with backoff
        throw new RetryableError(`GSP server error (HTTP ${res.status})`);
      }

      if (res.ok) {
        await this.handleGspSuccess(entity_type, entity_id, operation, responseBody, retry_id, tenant_id);
      } else {
        // 4xx errors (non-401) → check if retryable
        const isRetryable =
          res.status === 429 ||
          res.status === 408 ||
          (res.status >= 500);

        if (isRetryable) {
          throw new RetryableError(`GSP retryable error (HTTP ${res.status}): ${JSON.stringify(responseBody)}`);
        }

        // Permanent failure
        await this.handleGspPermanentFailure(
          entity_type, entity_id, retry_id, tenant_id,
          String(res.status), JSON.stringify(responseBody), "Permanent GSP error"
        );
      }
    } catch (err) {
      if (err instanceof RetryableError) {
        await this.scheduleRetry(retryItem, err.message);
      } else {
        await this.handleGspPermanentFailure(
          entity_type, entity_id, retry_id, tenant_id,
          "NETWORK_ERROR", "",
          err instanceof Error ? err.message : "Unknown error"
        );
      }
    }
  }

  // =========================================================================
  // STATUS QUERIES
  // =========================================================================

  async getEinvoiceStatus(eInvoiceId: number, tenantId: string): Promise<EInvoiceDetailRow | null> {
    const { rows } = await this.client.query<EInvoiceDetailRow>(
      `SELECT * FROM e_invoice_details WHERE e_invoice_id = $1 AND tenant_id = $2`,
      [eInvoiceId, tenantId]
    );
    return rows[0] ?? null;
  }

  async getEwayBillStatus(ewayBillId: number, tenantId: string): Promise<EwayBillDetailRow | null> {
    const { rows } = await this.client.query<EwayBillDetailRow>(
      `SELECT * FROM eway_bill_details WHERE eway_bill_id = $1 AND tenant_id = $2`,
      [ewayBillId, tenantId]
    );
    return rows[0] ?? null;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async resolveGspCredential(tenantId: string, gstRegId: number): Promise<number> {
    const { rows } = await this.client.query<{ gsp_credential_id: number }>(
      `SELECT gc.gsp_credential_id
       FROM gsp_credentials gc
       JOIN gst_registrations gr ON gr.gstin = gc.gstin
       WHERE gr.gst_registration_id = $1 AND gc.tenant_id = $2 AND gc.is_active = TRUE
       LIMIT 1`,
      [gstRegId, tenantId]
    );
    if (rows.length === 0) {
      throw new Error(`No active GSP credential found for GST registration ${gstRegId}`);
    }
    return rows[0].gsp_credential_id;
  }

  private async enqueueRetry(params: {
    entity_type: "E_INVOICE" | "EWAY_BILL";
    entity_id: number;
    operation: string;
    tenant_id: string;
    gsp_credential_id: number;
    endpoint_path: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    // Use INSERT ... ON CONFLICT DO NOTHING to avoid duplicate queuing
    await this.client.query(
      `INSERT INTO api_retry_queue (
         entity_type, entity_id, operation, tenant_id,
         gsp_credential_id, endpoint_path, payload,
         next_retry_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'QUEUED')
       ON CONFLICT (entity_type, entity_id, operation)
         WHERE status IN ('QUEUED', 'IN_PROGRESS')
       DO NOTHING`,
      [
        params.entity_type, params.entity_id, params.operation,
        params.tenant_id, params.gsp_credential_id,
        params.endpoint_path, JSON.stringify(params.payload),
      ]
    );
  }

  private async transitionStatus(
    eInvoiceId: number,
    newStatus: EInvoiceStatus,
    actor: string,
    tenantId?: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE e_invoice_details
       SET status = $2,
           status_history = status_history || jsonb_build_object(
             'status', $2, 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', $3
            ),
            updated_at = now()
        WHERE e_invoice_id = $1
          ${tenantId ? "AND tenant_id = $4" : ""}`,
      tenantId ? [eInvoiceId, newStatus, actor, tenantId] : [eInvoiceId, newStatus, actor]
    );
  }

  private async handleGspSuccess(
    entityType: string,
    entityId: number,
    operation: string,
    responseBody: Record<string, unknown>,
    retryId: number,
    tenantId: string
  ): Promise<void> {
    // Mark retry as SUCCESS
    await this.client.query(
      `UPDATE api_retry_queue
       SET status = 'SUCCESS', updated_at = now()
       WHERE retry_id = $1 AND tenant_id = $2`,
      [retryId, tenantId]
    );

    if (entityType === "E_INVOICE" && operation === "GENERATE") {
      // IRP response fields: IRN, AckNo, SignedQRCode, etc.
      await this.client.query(
        `UPDATE e_invoice_details
         SET irn = $2,
             ack_no = $3,
             ack_date = now(),
             signed_qrcode = $4,
             irp_signed_invoice = $5,
             irn_valid_until = now() + INTERVAL '72 hours',
             response_payload = $6,
             status = 'GENERATED',
             status_history = status_history || jsonb_build_object(
               'status', 'GENERATED', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', 'system'
             ),
             updated_at = now()
         WHERE e_invoice_id = $1 AND tenant_id = $7`,
        [
          entityId,
          responseBody.Irn ?? responseBody.IRN ?? null,
          responseBody.AckNo ?? responseBody.AckNo ?? null,
          responseBody.SignedQRCode ?? responseBody.SignedQRCode ?? null,
          JSON.stringify(responseBody),
          JSON.stringify(responseBody),
          tenantId,
        ]
      );
    } else if (entityType === "E_INVOICE" && operation === "CANCEL") {
      await this.client.query(
        `UPDATE e_invoice_details
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancellation_ack = $2,
             response_payload = $3,
             status_history = status_history || jsonb_build_object(
               'status', 'CANCELLED', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', 'system'
             ),
             updated_at = now()
         WHERE e_invoice_id = $1 AND tenant_id = $4`,
        [entityId, responseBody.AckNo ?? null, JSON.stringify(responseBody), tenantId]
      );
    } else if (entityType === "EWAY_BILL" && operation === "GENERATE") {
      await this.client.query(
        `UPDATE eway_bill_details
         SET ewb_no = $2,
             ewb_valid_until = $3,
             generation_date = now(),
             response_payload = $4,
             status = 'GENERATED',
             status_history = status_history || jsonb_build_object(
               'status', 'GENERATED', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', 'system'
             ),
             updated_at = now()
         WHERE eway_bill_id = $1 AND tenant_id = $5`,
        [
          entityId,
          responseBody.ewbNo ?? responseBody.EwbNo ?? null,
          responseBody.ewbValidTill ?? responseBody.ewayBillValidDate ?? null,
          JSON.stringify(responseBody),
          tenantId,
        ]
      );
    }
  }

  private async handleGspPermanentFailure(
    entityType: string,
    entityId: number,
    retryId: number,
    tenantId: string,
    errorCode: string,
    errorBody: string,
    errorMessage: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE api_retry_queue
       SET status = 'PERMANENTLY_FAILED', last_error_code = $2, last_error_body = $3, updated_at = now()
       WHERE retry_id = $1 AND tenant_id = $4`,
      [retryId, errorCode, errorBody, tenantId]
    );

    if (entityType === "E_INVOICE") {
      await this.client.query(
        `UPDATE e_invoice_details
         SET status = 'FAILED',
             irp_error_code = $2,
             irp_error_message = $3,
             status_history = status_history || jsonb_build_object(
               'status', 'FAILED', 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', 'system'
             ),
             updated_at = now()
         WHERE e_invoice_id = $1 AND tenant_id = $4`,
        [entityId, errorCode, errorMessage, tenantId]
      );
    } else if (entityType === "EWAY_BILL") {
      await this.client.query(
        `UPDATE eway_bill_details
         SET status = 'FAILED',
             nic_error_code = $2,
             nic_error_message = $3,
             updated_at = now()
         WHERE eway_bill_id = $1 AND tenant_id = $4`,
        [entityId, errorCode, errorMessage, tenantId]
      );
    }
  }

  private async scheduleRetry(retryItem: RetryQueueRow, errorMessage: string): Promise<void> {
    const attempt = retryItem.attempt_count + 1;
    const max = retryItem.max_attempts;

    if (attempt >= max) {
      await this.handleGspPermanentFailure(
        retryItem.entity_type, retryItem.entity_id, retryItem.retry_id, retryItem.tenant_id,
        "MAX_RETRIES_EXCEEDED", "",
        `Exceeded ${max} retry attempts. Last error: ${errorMessage}`
      );
      return;
    }

    // Exponential backoff: next_retry_at = NOW() + 2^attempt_count seconds
    const delaySeconds = Math.pow(2, attempt);
    await this.client.query(
      `UPDATE api_retry_queue
       SET status = 'QUEUED',
           next_retry_at = now() + $2 * INTERVAL '1 second',
           last_error_code = $3,
           last_error_body = $4,
           updated_at = now()
       WHERE retry_id = $1 AND tenant_id = $5`,
      [retryItem.retry_id, delaySeconds, "RETRYABLE_ERROR", errorMessage, retryItem.tenant_id]
    );
  }

  private async reenqueue(eInvoiceId: number, tenantId: string): Promise<EInvoiceStatus> {
    const { rows } = await this.client.query<EInvoiceDetailRow>(
      `SELECT * FROM e_invoice_details WHERE e_invoice_id = $1 AND tenant_id = $2`,
      [eInvoiceId, tenantId]
    );
    const einv = rows[0];
    if (!einv) throw new Error(`E-Invoice not found: ${eInvoiceId}`);

    const gspCredId = await this.resolveGspCredential(einv.tenant_id, einv.gst_registration_id);

    await this.enqueueRetry({
      entity_type: "E_INVOICE",
      entity_id: eInvoiceId,
      operation: "GENERATE",
      tenant_id: einv.tenant_id,
      gsp_credential_id: gspCredId,
      endpoint_path: "/api/v1/invoice/generate",
      payload: einv.request_payload,
    });

    await this.transitionStatus(eInvoiceId, "PENDING", "system", tenantId);
    return "PENDING";
  }
}

// ---------------------------------------------------------------------------
// Custom error for retryable GSP issues
// ---------------------------------------------------------------------------
class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

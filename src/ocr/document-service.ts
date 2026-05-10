// ============================================================================
// DOCUMENT SERVICE — Upload Management & S3 Integration
// ============================================================================

import { PoolClient } from "pg";
import crypto from "crypto";
import {
  UploadedDocumentRow,
  UploadDocumentInput,
  DocumentPreviewResponse,
  DocEntityType,
  DocumentStatus,
} from "./ocr-types";

export class DocumentService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Register an uploaded document in the database.
   * Called after the file has been saved to S3 by the client (via presigned URL)
   * or by the file-upload middleware.
   */
  async registerUpload(input: UploadDocumentInput): Promise<UploadedDocumentRow> {
    const s3Url = `https://${input.s3_bucket}.s3.${process.env.AWS_REGION ?? "ap-south-1"}.amazonaws.com/${input.s3_key}`;

    // Compute hash if not provided (for deduplication)
    const hash = input.file_hash_sha256 ?? null;

    const { rows } = await this.client.query<UploadedDocumentRow>(
      `INSERT INTO uploaded_documents (
         tenant_id, original_filename, s3_bucket, s3_key, s3_url,
         file_size_bytes, mime_type, page_count, file_hash_sha256,
         entity_type, upload_status, uploaded_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'UPLOADED',$11)
       ON CONFLICT (tenant_id, file_hash_sha256) DO UPDATE SET
         s3_url = EXCLUDED.s3_url,
         updated_at = now()
       RETURNING *`,
      [
        input.tenant_id, input.original_filename,
        input.s3_bucket, input.s3_key, s3Url,
        input.file_size_bytes ?? null, input.mime_type ?? null,
        input.page_count ?? 1, hash,
        input.entity_type ?? "PURCHASE_INVOICE",
        input.uploaded_by ?? null,
      ]
    );
    return rows[0];
  }

  /**
   * Get document info by ID.
   */
  async getDocument(documentId: number, tenantId?: string): Promise<UploadedDocumentRow | null> {
    const { rows } = await this.client.query<UploadedDocumentRow>(
      `SELECT * FROM uploaded_documents
       WHERE document_id = $1
         ${tenantId ? "AND tenant_id = $2" : ""}`,
      tenantId ? [documentId, tenantId] : [documentId]
    );
    return rows[0] ?? null;
  }

  /**
   * List documents for a tenant with optional status filter.
   */
  async listDocuments(
    tenantId: string,
    status?: DocumentStatus,
    entityType?: DocEntityType,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ documents: UploadedDocumentRow[]; total: number }> {
    const conditions: string[] = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (status) {
      conditions.push(`upload_status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }
    if (entityType) {
      conditions.push(`entity_type = $${paramIdx}`);
      params.push(entityType);
      paramIdx++;
    }

    const whereClause = conditions.join(" AND ");

    const { rows: countRows } = await this.client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM uploaded_documents WHERE ${whereClause}`,
      params
    );

    params.push(limit);
    params.push(offset);
    const { rows } = await this.client.query<UploadedDocumentRow>(
      `SELECT * FROM uploaded_documents
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
    );

    return { documents: rows, total: Number(countRows[0].count) };
  }

  /**
   * Update document status with history tracking.
   */
  async updateStatus(
    documentId: number,
    newStatus: DocumentStatus,
    actor: string = "system",
    errorMessage?: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE uploaded_documents
       SET upload_status = $2,
           status_history = status_history || jsonb_build_object(
             'status', $2, 'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'actor', $3
           ),
           error_message = CASE WHEN $4 IS NOT NULL THEN $4 ELSE error_message END,
           updated_at = now()
       WHERE document_id = $1`,
      [documentId, newStatus, actor, errorMessage ?? null]
    );
  }

  /**
   * Get documents pending OCR processing (QUEUED status).
   */
  async getPendingOcrDocuments(limit: number = 10): Promise<UploadedDocumentRow[]> {
    const { rows } = await this.client.query<UploadedDocumentRow>(
      `SELECT * FROM uploaded_documents
       WHERE upload_status = 'QUEUED'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    return rows;
  }

  /**
   * Generate a presigned POST URL for direct S3 upload (client-side).
   * This is a placeholder — in production, use @aws-sdk/s3-request-presigner.
   */
  generatePresignedUploadUrl(
    tenantId: string,
    filename: string,
    contentType: string
  ): { url: string; fields: Record<string, string>; key: string } {
    const timestamp = Date.now();
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `uploads/${tenantId}/${timestamp}_${safeFilename}`;
    const bucket = process.env.S3_UPLOAD_BUCKET ?? "glm-documents";

    // Placeholder — replace with actual @aws-sdk/client-s3 presigner
    const url = `https://${bucket}.s3.${process.env.AWS_REGION ?? "ap-south-1"}.amazonaws.com/`;

    return {
      url,
      fields: {
        key,
        bucket,
        "Content-Type": contentType,
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      },
      key,
    };
  }
}

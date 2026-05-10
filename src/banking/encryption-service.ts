import crypto from "crypto";

// ---------------------------------------------------------------------------
// BANK DATA ENCRYPTION SERVICE — PII at Rest (AES-256-GCM envelope encryption)
// ---------------------------------------------------------------------------
//
// Strategy: ENVELOPE ENCRYPTION
//   1. A Data Encryption Key (DEK) is generated per bank_account row.
//   2. The DEK is encrypted with a Master Key (KEK) stored in HSM / KMS.
//   3. Sensitive fields (account_number) are encrypted with the DEK.
//   4. For database lookups, a SHA-256 hash of the plaintext is stored.
//   5. For display, only the masked version is returned (XXXX7890).
//
// Why envelope encryption?
//   - Rotating the master key doesn't require re-encrypting all data.
//   - Each record has its own DEK, limiting blast radius if one DEK leaks.
//   - Compatible with AWS KMS / Google Cloud KMS / HashiCorp Vault.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEK_LENGTH = 32; // 256 bits

/**
 * In production, the Master Key comes from a KMS (AWS KMS, GCP KMS, Vault).
 * DO NOT hardcode — this is a placeholder for local dev only.
 */
const masterKeyRaw = process.env.ENCRYPTION_MASTER_KEY;
if (!masterKeyRaw || masterKeyRaw.length < 32) {
  throw new Error(
    "ENCRYPTION_MASTER_KEY environment variable is required and must be at least 32 characters long."
  );
}
const MASTER_KEY = crypto.scryptSync(masterKeyRaw, "glm-banking-salt", 32);

// -----------------------------------------------------------------------
// KEY MANAGEMENT (Data Encryption Key per record)
// -----------------------------------------------------------------------

export function generateDEK(): Buffer {
  return crypto.randomBytes(DEK_LENGTH);
}

export function encryptDEK(dek: Buffer): { encryptedDEK: Buffer; iv: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);

  let encrypted = cipher.update(dek);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { encryptedDEK: encrypted, iv, tag: authTag };
}

export function decryptDEK(
  encryptedDEK: Buffer,
  iv: Buffer,
  tag: Buffer
): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedDEK);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted;
}

// -----------------------------------------------------------------------
// FIELD ENCRYPTION (using DEK)
// -----------------------------------------------------------------------

export function encryptField(plaintext: string, dek: Buffer): { encrypted: Buffer; iv: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);

  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { encrypted, iv, tag: authTag };
}

export function decryptField(
  encrypted: Buffer,
  iv: Buffer,
  tag: Buffer,
  dek: Buffer
): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString("utf8");
}

// -----------------------------------------------------------------------
// HIGH-LEVEL API — what the service layer calls
// -----------------------------------------------------------------------

/**
 * Encrypt a bank account number for storage.
 * Returns:
 *  - encrypted_blob: IV(12) + TAG(16) + ENCRYPTED_DEK(32+16+16) + CIPHERTEXT
 *    (self-contained blobs; no separate DEK storage needed)
 *  - hash: SHA-256 of the plaintext (for dedup/index lookups)
 *  - masked: Last 4 digits visible, rest masked (e.g. XXXXXXXXXX7890)
 */
export function encryptAccountNumber(plaintext: string): {
  encryptedBlob: Buffer;
  accountHash: string;
  accountMasked: string;
} {
  // Generate per-record DEK
  const dek = generateDEK();

  // Encrypt DEK with master key
  const { encryptedDEK, iv: dekIv, tag: dekTag } = encryptDEK(dek);

  // Encrypt the field with DEK
  const { encrypted, iv: fieldIv, tag: fieldTag } = encryptField(plaintext, dek);

  // Pack into a self-contained blob:
  //   [DEK_IV:12 | DEK_TAG:16 | FIELD_IV:12 | FIELD_TAG:16 | ENCRYPTED_DEK:64 | CIPHERTEXT:variable]
  const blob = Buffer.concat([
    dekIv, dekTag, fieldIv, fieldTag,
    encryptedDEK, encrypted,
  ]);

  // Hash for lookups (deterministic, not reversible)
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");

  // Masked for display
  const masked = plaintext.length > 4
    ? "X".repeat(plaintext.length - 4) + plaintext.slice(-4)
    : plaintext;

  return { encryptedBlob: blob, accountHash: hash, accountMasked: masked };
}

/**
 * Decrypt a bank account number from storage.
 */
export function decryptAccountNumber(encryptedBlob: Buffer): string {
  let offset = 0;

  const dekIv  = encryptedBlob.subarray(offset, offset + IV_LENGTH);     offset += IV_LENGTH;
  const dekTag = encryptedBlob.subarray(offset, offset + TAG_LENGTH);    offset += TAG_LENGTH;
  const fieldIv  = encryptedBlob.subarray(offset, offset + IV_LENGTH);   offset += IV_LENGTH;
  const fieldTag = encryptedBlob.subarray(offset, offset + TAG_LENGTH);  offset += TAG_LENGTH;
  const encryptedDEK  = encryptedBlob.subarray(offset, offset + 64);     offset += 64;
  const ciphertext = encryptedBlob.subarray(offset);

  const dek = decryptDEK(encryptedDEK, dekIv, dekTag);
  return decryptField(ciphertext, fieldIv, fieldTag, dek);
}

/**
 * Generate a hash for an account number (for lookup without storing plaintext).
 */
export function hashAccountNumber(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

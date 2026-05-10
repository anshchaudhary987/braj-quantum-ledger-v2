// ============================================================================
// GSP AUTHENTICATION SERVICE
// Handles token lifecycle, caching, and auto-refresh for GSP/NIC portals.
// ============================================================================

import { getPool, withClient } from "../db/pool.js";
import { GspCredentialRow, GspAuthToken } from "./einvoice-types.js";

// In-memory token store keyed by gsp_credential_id
const tokenCache = new Map<number, GspAuthToken>();

export class GspAuthService {
  /**
   * Returns a valid (non-expired) bearer token for the given GSP credential.
   * If the cached token is still valid, returns it directly.
   * If expired or missing, calls the GSP auth endpoint and caches the new token.
   */
  static async getToken(gspCredentialId: number): Promise<string> {
    const cached = tokenCache.get(gspCredentialId);
    if (cached && cached.expires_at > Date.now() + 60_000) {
      // Token still valid with at least 60s buffer
      return cached.access_token;
    }

    const cred = await GspAuthService.loadCredential(gspCredentialId);
    const token = await GspAuthService.fetchTokenFromGsp(cred);
    tokenCache.set(gspCredentialId, token);
    return token.access_token;
  }

  /**
   * Force-refresh a token (used when GSP responds with 401).
   */
  static async invalidateToken(gspCredentialId: number): Promise<string> {
    tokenCache.delete(gspCredentialId);
    return GspAuthService.getToken(gspCredentialId);
  }

  /**
   * Load GSP credentials from DB. Decrypts client_secret at the app layer
   * (encryption/decryption via a KMS-backed cipher — implementation omitted).
   */
  private static async loadCredential(
    gspCredentialId: number
  ): Promise<{ client_id: string; client_secret: string; auth_endpoint: string; base_url: string }> {
    return withClient(async (client) => {
      const { rows } = await client.query<GspCredentialRow>(
        `SELECT client_id, client_secret, auth_endpoint, base_url
         FROM gsp_credentials WHERE gsp_credential_id = $1 AND is_active = TRUE`,
        [gspCredentialId]
      );
      if (rows.length === 0) {
        throw new Error(`GSP credential not found or inactive: ${gspCredentialId}`);
      }
      const r = rows[0];
      return {
        client_id: r.client_id,
        // In production: decrypt(r.client_secret) via KMS/HSM-backed AES-256-GCM
        client_secret: Buffer.from(r.client_secret).toString("utf-8"),
        auth_endpoint: r.auth_endpoint,
        base_url: r.base_url,
      };
    });
  }

  /**
   * POST to the GSP token endpoint with client_credentials grant.
   */
  private static async fetchTokenFromGsp(cred: {
    client_id: string;
    client_secret: string;
    auth_endpoint: string;
  }): Promise<GspAuthToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cred.client_id,
      client_secret: cred.client_secret,
    });

    const res = await fetch(cred.auth_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GSP Auth failed (HTTP ${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope?: string;
    };

    return {
      access_token: data.access_token,
      token_type: data.token_type ?? "Bearer",
      expires_at: Date.now() + data.expires_in * 1000,
      scope: data.scope ?? "",
    };
  }
}

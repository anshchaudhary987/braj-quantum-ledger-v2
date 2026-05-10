// ============================================================================
// DISTANCE AUTO-CALCULATION SERVICE
// E-Way Bill Distance Calculation between Dispatch PIN and Ship-to PIN.
//
// Strategy:
//   1. Primary: Google Maps Distance Matrix API (real driving distance)
//   2. Fallback: Haversine formula via pin_code_master (straight-line)
//   3. Last resort: Return null — user must provide manually
//
// Output cached in eway_bill_details.approx_distance_km +
// distance_calc_response (raw API response for audit).
// ============================================================================

import { PoolClient } from "pg";
import { DistanceCalcResult } from "./einvoice-types";

interface PinCodeRow {
  pin_code: string;
  latitude: string;
  longitude: string;
  is_verified: boolean;
}

interface GoogleMapsResponse {
  rows?: Array<{
    elements?: Array<{
      status: string;
      distance?: { value: number; text: string };
      duration?: { value: number; text: string };
    }>;
  }>;
  status: string;
  error_message?: string;
}

export class DistanceService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Main entry point: calculate distance between two PIN codes.
   * Returns { distance_km, source, raw_response }.
   */
  async calculate(
    fromPin: string,
    toPin: string
  ): Promise<DistanceCalcResult> {
    if (fromPin === toPin) {
      return { distance_km: 0, source: "PINCODE_MASTER" };
    }

    // ---- Strategy 1: Google Maps Distance Matrix API ----
    const googleResult = await this.tryGoogleMaps(fromPin, toPin);
    if (googleResult) return googleResult;

    // ---- Strategy 2: Haversine via pin_code_master ----
    const haversineResult = await this.tryHaversine(fromPin, toPin);
    if (haversineResult) return haversineResult;

    // ---- Strategy 3: Unavailable — caller must prompt user ----
    return { distance_km: 0, source: "MANUAL", raw_response: { error: "Distance could not be calculated automatically. Please enter manually." } };
  }

  /**
   * Batch-calculate distances (e.g., for bulk e-way bill generation).
   */
  async calculateBatch(
    pairs: Array<{ fromPin: string; toPin: string }>
  ): Promise<DistanceCalcResult[]> {
    return Promise.all(pairs.map((p) => this.calculate(p.fromPin, p.toPin)));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — Google Maps Distance Matrix API
  // ──────────────────────────────────────────────────────────────────────────

  private async tryGoogleMaps(
    fromPin: string,
    toPin: string
  ): Promise<DistanceCalcResult | null> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return null;

    try {
      const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
      url.searchParams.set("origins", fromPin);
      url.searchParams.set("destinations", toPin);
      url.searchParams.set("mode", "driving");
      url.searchParams.set("units", "metric");
      url.searchParams.set("key", apiKey);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const data = (await res.json()) as GoogleMapsResponse;
      if (data.status !== "OK") return null;

      const element = data.rows?.[0]?.elements?.[0];
      if (!element || element.status !== "OK" || !element.distance) return null;

      return {
        distance_km: Math.round((element.distance.value / 1000) * 100) / 100,
        source: "GOOGLE_MAPS",
        raw_response: data as unknown as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — Haversine via pin_code_master
  // ──────────────────────────────────────────────────────────────────────────

  private async tryHaversine(
    fromPin: string,
    toPin: string
  ): Promise<DistanceCalcResult | null> {
    // Use the DB function for DB-level Haversine
    try {
      const { rows } = await this.client.query<{ haversine_distance_km: string }>(
        `SELECT haversine_distance_km($1, $2) AS haversine_distance_km`,
        [fromPin, toPin]
      );
      const km = Number(rows[0]?.haversine_distance_km);
      if (km === null || isNaN(km)) return null;

      return {
        distance_km: km,
        source: "PINCODE_MASTER",
        raw_response: { method: "haversine", from_pin: fromPin, to_pin: toPin },
      };
    } catch {
      return null;
    }
  }

  /**
   * Look up a PIN code's coordinates for UI display / manual override.
   */
  async lookupPinCode(pin: string): Promise<PinCodeRow | null> {
    const { rows } = await this.client.query<PinCodeRow>(
      `SELECT pin_code, latitude, longitude, is_verified
       FROM pin_code_master WHERE pin_code = $1`,
      [pin]
    );
    return rows[0] ?? null;
  }

  /**
   * Upsert a PIN code into the master (self-healing: cache Google Maps geocodes).
   */
  async upsertPinCode(
    pin: string,
    city: string,
    district: string,
    stateCode: string,
    lat: number,
    lng: number
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO pin_code_master (pin_code, city, district, state_code, latitude, longitude, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (pin_code) DO UPDATE SET
         city = EXCLUDED.city,
         district = EXCLUDED.district,
         state_code = EXCLUDED.state_code,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         is_verified = TRUE,
         updated_at = now()`,
      [pin, city, district, stateCode, lat, lng]
    );
  }
}
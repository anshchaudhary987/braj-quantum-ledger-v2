import { GstinValidationResult, StateMasterRow } from "./gst-types.js";

// ---------------------------------------------------------------------------
// GST VALIDATOR — GSTIN format, checksum, state code, PAN extraction
// ---------------------------------------------------------------------------

/**
 * GSTIN structure (15 chars):
 *   [0-1]: State code (01-38)
 *   [2-6]: PAN first 5 chars (uppercase letters)
 *   [7-10]: PAN next 4 chars (digits)
 *   [11]: PAN last char (letter)
 *   [12]: Entity number on same PAN (1-9, A-Z)
 *   [13]: Fixed 'Z'
 *   [14]: Checksum (alphanumeric)
 *
 * Example: 27AABCT1234A[1]Z[5]
 */

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/**
 * GSTIN checksum validation using the Luhn-mod-N algorithm
 * with the character set used by the GST Network.
 */
function validateChecksum(gstin: string): boolean {
  const charSet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const n = charSet.length;

  let factor = 2;
  let sum = 0;
  let codePoint: number;

  // Walk from right to left on the first 14 characters
  for (let i = 13; i >= 0; i--) {
    codePoint = charSet.indexOf(gstin[i]);
    if (codePoint === -1) return false;

    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;

    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }

  const remainder = sum % n;
  const checkDigit = (n - remainder) % n;

  return charSet[checkDigit] === gstin[14];
}

// Indian state codes 01-38
const VALID_STATE_CODES = new Set([
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
  "21", "22", "23", "24", "26", "27", "29", "30", "31", "32",
  "33", "34", "35", "36", "37", "38",
]);

export function validateGstin(gstin: string): GstinValidationResult {
  if (!gstin || gstin.length !== 15) {
    return {
      isValid: false,
      gstin,
      stateCode: null,
      pan: null,
      errorMessage: `GSTIN must be exactly 15 characters, got ${gstin?.length ?? 0}.`,
    };
  }

  const upper = gstin.toUpperCase();

  if (!GSTIN_PATTERN.test(upper)) {
    return {
      isValid: false,
      gstin: upper,
      stateCode: null,
      pan: null,
      errorMessage: "GSTIN format invalid. Expected: 2 digits + PAN + entity number + Z + checksum.",
    };
  }

  if (!validateChecksum(upper)) {
    return {
      isValid: false,
      gstin: upper,
      stateCode: upper.substring(0, 2),
      pan: null,
      errorMessage: "GSTIN checksum verification failed.",
    };
  }

  const stateCode = upper.substring(0, 2);
  if (!VALID_STATE_CODES.has(stateCode)) {
    return {
      isValid: false,
      gstin: upper,
      stateCode,
      pan: null,
      errorMessage: `Invalid state code: ${stateCode}.`,
    };
  }

  const pan = upper.substring(2, 12);

  return {
    isValid: true,
    gstin: upper,
    stateCode,
    pan,
  };
}

/**
 * Validates that the place of supply state code is reasonable given
 * the counterparty's GSTIN. For B2B goods, these should match.
 * For services, they may differ. This returns a warning rather than
 * rejecting outright.
 */
export function validatePlaceOfSupply(
  placeOfSupplyCode: string,
  counterpartyGstin?: string
): { isValid: boolean; warning?: string } {
  if (!VALID_STATE_CODES.has(placeOfSupplyCode)) {
    return { isValid: false, warning: `Invalid state code: ${placeOfSupplyCode}.` };
  }

  if (counterpartyGstin) {
    const cpValidation = validateGstin(counterpartyGstin);
    if (cpValidation.isValid && cpValidation.stateCode !== placeOfSupplyCode) {
      return {
        isValid: true,
        warning: `Place of supply (${placeOfSupplyCode}) differs from counterparty GSTIN state (${cpValidation.stateCode}). ` +
                 `Ensure this is correct (e.g., inter-state service delivery).`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Given a state code, determines if it's a Union Territory without its
 * own legislature (uses UTGST instead of SGST for intra-state).
 *
 * UT without legislature: Chandigarh(04), DNH(26), Lakshadweep(31),
 *                          Andaman(35), Ladakh(38)
 */
export function isUnionTerritoryWithoutLegislature(
  stateCode: string,
  stateMaster: Map<string, StateMasterRow>
): boolean {
  const state = stateMaster.get(stateCode);
  if (!state) return false;
  return state.region_type === "UNION_TERRITORY" && !state.has_own_legislature;
}

export function extractPan(gstin: string): string {
  return gstin.substring(2, 12);
}

export function extractStateCode(gstin: string): string {
  return gstin.substring(0, 2);
}

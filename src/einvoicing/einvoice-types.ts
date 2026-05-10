// ============================================================================
// E-INVOICING (IRP) & E-WAY BILL (NIC) — TypeScript Type Definitions
// ============================================================================

// ── ENUMS ──────────────────────────────────────────────────────────────────

export type EInvoiceStatus =
  | "DRAFT"
  | "PENDING"
  | "SUBMITTED"
  | "GENERATED"
  | "CANCELLED"
  | "FAILED"
  | "EXPIRED";

export type EwayBillStatus =
  | "PENDING"
  | "QUEUED"
  | "GENERATED"
  | "EXTENDED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export type SupplyType =
  | "B2B"
  | "B2C"
  | "SEZWP"
  | "SEZWOP"
  | "EXPWP"
  | "EXPWOP"
  | "DEXP";

export type TransportMode = "ROAD" | "RAIL" | "AIR" | "SHIP";
export type RetryQueueStatus = "QUEUED" | "IN_PROGRESS" | "SUCCESS" | "PERMANENTLY_FAILED";
export type EntityType = "E_INVOICE" | "EWAY_BILL";

// ── DATABASE ROW TYPES ─────────────────────────────────────────────────────

export interface GspCredentialRow {
  gsp_credential_id: number;
  tenant_id: string;
  gstin: string;
  gsp_name: string;
  client_id: string;
  client_secret: Buffer;
  auth_endpoint: string;
  base_url: string;
  is_active: boolean;
}

export interface EInvoiceDetailRow {
  e_invoice_id: number;
  transaction_id: number;
  tenant_id: string;
  gst_registration_id: number;
  invoice_number: string;
  invoice_date: string;
  supply_type: SupplyType;
  is_reverse_charge: boolean;
  irn: string | null;
  ack_no: string | null;
  ack_date: string | null;
  signed_qrcode: string | null;
  irp_signed_invoice: string | null;
  irn_valid_until: string | null;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown> | null;
  irp_error_code: string | null;
  irp_error_message: string | null;
  status: EInvoiceStatus;
  status_history: StatusHistoryEntry[];
  cancelled_at: string | null;
  cancelled_reason: string | null;
  cancellation_ack: string | null;
  credit_note_ref: number | null;
  created_at: string;
}

export interface EwayBillDetailRow {
  eway_bill_id: number;
  e_invoice_id: number | null;
  transaction_id: number | null;
  tenant_id: string;
  gst_registration_id: number;
  ewb_no: string | null;
  ewb_valid_until: string | null;
  generation_date: string | null;
  supply_type: SupplyType;
  sub_supply_type: string;
  document_type: string;
  document_number: string | null;
  document_date: string | null;
  dispatch_from_pin: string;
  ship_to_pin: string;
  approx_distance_km: string | null;
  distance_source: string | null;
  distance_calc_response: Record<string, unknown> | null;
  transport_mode: TransportMode;
  vehicle_number: string | null;
  transporter_id: string | null;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown> | null;
  nic_error_code: string | null;
  nic_error_message: string | null;
  status: EwayBillStatus;
  status_history: StatusHistoryEntry[];
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
}

export interface RetryQueueRow {
  retry_id: number;
  entity_type: EntityType;
  entity_id: number;
  operation: string;
  tenant_id: string;
  gsp_credential_id: number | null;
  endpoint_path: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error_body: Record<string, unknown> | null;
  last_attempted_at: string | null;
  next_retry_at: string;
  status: RetryQueueStatus;
}

// ── STATUS HISTORY ──────────────────────────────────────────────────────────

export interface StatusHistoryEntry {
  status: string;
  timestamp: string;
  actor: string;
}

// ── GSP AUTH ────────────────────────────────────────────────────────────────

export interface GspAuthToken {
  access_token: string;
  token_type: string;
  expires_at: number;           // epoch ms
  scope: string;
}

// ── INV-01 JSON SCHEMA TYPES (E-Invoice payload as per GoI spec) ────────────

export interface Inv01TransactionDetail {
  TaxSch: "GST";
  SupTyp: SupplyType;
  RegRev: "Y" | "N";            // Y = Reverse Charge
  IgstOnIntra: "N";             // hardcode N for domestic
}

export interface Inv01BuyerDetail {
  Gstin: string;
  LglNm: string;
  TrdNm?: string;
  Pos: string;                  // 2-digit state code
  Addr1: string;
  Loc: string;
  Pin: number;
  Stcd: string;
  Ph?: string;
  Em?: string;
}

export interface Inv01SellerDetail {
  Gstin: string;
  LglNm: string;
  TrdNm?: string;
  Addr1: string;
  Loc: string;
  Pin: number;
  Stcd: string;
  Ph?: string;
  Em?: string;
}

export interface Inv01ItemDetail {
  SlNo: string;
  PrdDesc: string;
  IsServc: "Y" | "N";
  HsnCd: string;
  Qty: number;
  Unit: string;
  UnitPrice: number;
  TotAmt: number;               // Qty * UnitPrice
  Discount: number;
  PreTaxVal: number;
  AssAmt: number;               // taxable value
  GstRt: number;                // total rate (e.g. 18)
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesRt: number;
  CesAmt: number;
  CesNonAdvlAmt: number;
  StateCesRt: number;
  StateCesAmt: number;
  StateCesNonAdvlAmt: number;
  OthChrg: number;
  TotItemVal: number;
}

export interface Inv01InvoiceValue {
  AssVal: number;               // sum of all item taxable values
  CgstVal: number;
  SgstVal: number;
  IgstVal: number;
  CesVal: number;
  StCesVal: number;
  Discount: number;
  OthChrg: number;
  RndOffAmt: number;
  TotInvVal: number;
  TotInvValFc: number;
}

export interface Inv01DocumentDetail {
  Typ: "INV" | "CRN" | "DBN";
  No: string;
  Dt: string;                  // DD/MM/YYYY
}

export interface Inv01Payload {
  Version: "1.1";
  TranDtls: Inv01TransactionDetail;
  DocDtls: {
    Typ: "INV" | "CRN" | "DBN";
    No: string;
    Dt: string;                  // DD/MM/YYYY
  };
  SellerDtls: Inv01SellerDetail;
  BuyerDtls: Inv01BuyerDetail;
  DispDtls?: {
    Nm: string;
    Addr1: string;
    Loc: string;
    Pin: number;
    Stcd: string;
  };
  ShipDtls?: {
    Gstin: string;
    LglNm: string;
    Addr1: string;
    Loc: string;
    Pin: number;
    Stcd: string;
  };
  ItemList: Inv01ItemDetail[];
  ValDtls: Inv01InvoiceValue;
  PayDtls?: {
    Nm?: string;
    AccDet?: string;
    Mode?: string;
    FinInsBr?: string;
    PayTerm?: string;
    PayInstr?: string;
  };
  RefDtls?: {
    InvRm?: string;
    DocPerdDtls?: { InvStDt: string; InvEndDt: string };
    PrecDocDtls?: Array<{ InvNo: string; InvDt: string; }>;
  };
  AddlDocDtls?: Array<{
    Url: string;
    Docs: string;
    Info: string;
  }>;
  ExpDtls?: {
    ShipBNo?: string;
    ShipBDt?: string;
    Port?: string;
    RefClm?: string;
    ForCur?: string;
    CntCode?: string;
    ExpDuty?: number;
  };
  EwbDtls?: {
    TransId?: string;
    TransName?: string;
    Distance?: number;
    TransMode?: TransportMode;
    VehicleNo?: string;
    VehicleType?: string;
  };
}

// ── E-WAY BILL JSON SCHEMA (NIC API) ───────────────────────────────────────

export interface EwayBillPayload {
  supplyType: SupplyType;
  subSupplyType: string;
  docType: string;
  docNo: string;
  docDate: string;               // DD/MM/YYYY
  fromGstin: string;
  fromTrdName: string;
  fromAddr1: string;
  fromAddr2?: string;
  fromPlace: string;
  fromPincode: number;
  fromStateCode: number;
  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toAddr2?: string;
  toPlace: string;
  toPincode: number;
  toStateCode: number;
  totalValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  cessValue: number;
  transporterId?: string;
  transporterName?: string;
  transMode: TransportMode;
  transDistance: number;         // mandatory for ROAD
  vehicleNo?: string;
  vehicleType?: string;
  itemList: Array<{
    itemNo: number;
    productName: string;
    productDesc: string;
    hsnCode: string;
    quantity: number;
    qtyUnit: string;
    taxableAmount: number;
    taxRate: number;
    igstAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    cessAmount: number;
  }>;
}

// ── SERVICE INPUTS / OUTPUTS ────────────────────────────────────────────────

export interface GenerateEinvoiceInput {
  transaction_id: number;
  tenant_id: string;
  gst_registration_id: number;
  invoice_number: string;
  invoice_date: string;
  supply_type: SupplyType;
  is_reverse_charge?: boolean;
}

export interface GenerateEwayBillInput {
  e_invoice_id?: number;         // if linked from e-invoice IRN
  transaction_id?: number;
  tenant_id: string;
  gst_registration_id: number;
  dispatch_from_pin: string;
  ship_to_pin: string;
  transport_mode: TransportMode;
  vehicle_number?: string;
  transporter_id?: string;
  supply_type?: SupplyType;
}

export interface CancelEinvoiceInput {
  tenant_id: string;
  e_invoice_id: number;
  reason: string;
  force_credit_note?: boolean;   // if true, skip 24h check and create CN instead
}

export interface CancelEwayBillInput {
  eway_bill_id: number;
  reason: string;
}

export interface DistanceCalcResult {
  distance_km: number;
  source: "GOOGLE_MAPS" | "PINCODE_MASTER" | "MANUAL";
  raw_response?: Record<string, unknown>;
}

export interface GspApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error_code?: string;
  error_message?: string;
  http_status: number;
}

-- ============================================================================
-- E-INVOICING (IRP) & E-WAY BILL (NIC) — Government API Integration Layer
-- PostgreSQL 15+  |  Cloud-Native Accounting Backend
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. ENUM TYPES
-------------------------------------------------------------------------------

-- Lifecycle states for an e-invoice submitted to the Invoice Registration Portal
DO $$ BEGIN
    CREATE TYPE e_invoice_status AS ENUM (
        'DRAFT',            -- Created but not yet submitted to IRP
        'PENDING',          -- Queued for submission (waiting for GSP gateway)
        'SUBMITTED',        -- Successfully pushed to IRP, awaiting response
        'GENERATED',        -- IRN + QR Code + Ack received
        'CANCELLED',        -- Cancelled within 24-hour window
        'FAILED',           -- IRP returned an error / GSP layer failure
        'EXPIRED'           -- 24-hour cancellation window passed; Credit Note route
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- E-Way Bill lifecycle
DO $$ BEGIN
    CREATE TYPE eway_bill_status AS ENUM (
        'PENDING',          -- Not yet generated
        'QUEUED',           -- In retry queue for NIC
        'GENERATED',        -- E-Way Bill number received
        'EXTENDED',         -- Validity extended by user
        'CANCELLED',        -- Cancelled before expiry
        'EXPIRED',          -- Validity period expired
        'FAILED'            -- NIC returned an error
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Supply type for e-invoice classification
DO $$ BEGIN
    CREATE TYPE supply_type AS ENUM (
        'B2B',              -- Business to Business (default for registered dealers)
        'B2C',              -- Business to Consumer
        'SEZWP',            -- SEZ with payment of tax
        'SEZWOP',           -- SEZ without payment of tax
        'EXPWP',            -- Export with payment of tax
        'EXPWOP',           -- Export without payment of tax
        'DEXP'              -- Deemed Export
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- E-Way Bill transport mode
DO $$ BEGIN
    CREATE TYPE transport_mode AS ENUM (
        'ROAD',             -- Default; requires approx distance
        'RAIL',
        'AIR',
        'SHIP'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-------------------------------------------------------------------------------
-- 2. GSP / GATEWAY CREDENTIAL STORE
--    Stores GSP client credentials per tenant; used to fetch Auth Tokens from
--    the GSP or NIC sandbox. Tokens are cached in-memory by the service layer.
-------------------------------------------------------------------------------
CREATE TABLE gsp_credentials (
    gsp_credential_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         UUID         NOT NULL,
    gstin             VARCHAR(15)  NOT NULL REFERENCES gst_registrations(gstin),
    gsp_name          VARCHAR(100) NOT NULL,                     -- e.g. 'ClearTax', 'IRIS', 'MasterGST', 'NIC-Direct'
    client_id         VARCHAR(200) NOT NULL,
    client_secret     BYTEA        NOT NULL,                     -- encrypted at rest (AES-256-GCM)
    auth_endpoint     VARCHAR(500) NOT NULL,                     -- GSP token URL
    base_url          VARCHAR(500) NOT NULL,                     -- GSP API base
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, gstin, gsp_name)
);

-- Fast lookup by GSTIN (each registration may use a different GSP)
CREATE INDEX idx_gsp_cred_gstin ON gsp_credentials(gstin) WHERE is_active = TRUE;

-------------------------------------------------------------------------------
-- 3. E-INVOICE DETAILS
--    One row per invoice sent to the IRP. Links back to the core transaction
--    and the GST registration that generated it.
-------------------------------------------------------------------------------
CREATE TABLE e_invoice_details (
    -- ── Primary Key ──
    e_invoice_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- ── Accounting Link ──
    transaction_id   BIGINT        NOT NULL REFERENCES transactions(transaction_id),
    tenant_id        UUID          NOT NULL,
    gst_registration_id BIGINT     NOT NULL REFERENCES gst_registrations(gst_registration_id),

    -- ── Invoice Identifier ──
    invoice_number   VARCHAR(16)   NOT NULL,                     -- max 16 chars as per IRP spec
    invoice_date     DATE          NOT NULL,

    -- ── Supply Classification ──
    supply_type      supply_type   NOT NULL DEFAULT 'B2B',
    is_reverse_charge BOOLEAN      NOT NULL DEFAULT FALSE,

    -- ── IRP Response Fields (populated after successful generation) ──
    irn              VARCHAR(64),                                -- Invoice Reference Number (64-char hash)
    ack_no           VARCHAR(18),                                -- Acknowledgement Number
    ack_date         TIMESTAMPTZ,                                -- When IRP acknowledged
    signed_qrcode    TEXT,                                       -- Signed QR Code payload (Base64 or URL-safe)
    irp_signed_invoice TEXT,                                     -- IRP-signed JSON of the original invoice
    irn_valid_until  TIMESTAMPTZ,                                -- typically ack_date + 72 hours for e-way bill linking

    -- ── JSON Payloads (audit trail) ──
    request_payload  JSONB         NOT NULL,                     -- The INV-01 JSON we sent to IRP
    response_payload JSONB,                                      -- Raw IRP response (for debugging)
    irp_error_code   VARCHAR(50),                                -- e.g. 'ERR-001' from IRP
    irp_error_message TEXT,                                      -- Human-readable error

    -- ── Status Lifecycle ──
    status           e_invoice_status NOT NULL DEFAULT 'DRAFT',
    status_history   JSONB         NOT NULL DEFAULT '[]'::jsonb, -- [{ status, timestamp, actor }]

    -- ── Cancellation ──
    cancelled_at     TIMESTAMPTZ,
    cancelled_reason TEXT,
    cancellation_ack VARCHAR(18),                                -- IRP returns AckNo for cancellation too
    credit_note_ref  BIGINT,                                     -- FK to self if Credit Note issued instead
    cancelled_irn    VARCHAR(64),                                -- e-invoice can be cancelled only via IRP cancel API

    -- ── Audit ──
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Prevent duplicate IRN submissions per invoice_number + registration
CREATE UNIQUE INDEX idx_einv_invoice_number ON e_invoice_details(gst_registration_id, invoice_number);

-- Fast lookup by transaction
CREATE INDEX idx_einv_transaction ON e_invoice_details(transaction_id);

-- IRN lookup (from QR code scans / portal)
CREATE INDEX idx_einv_irn ON e_invoice_details(irn) WHERE irn IS NOT NULL;

-- Queue processing: find all invoices awaiting retry
CREATE INDEX idx_einv_status_retry ON e_invoice_details(status, updated_at)
    WHERE status IN ('PENDING', 'FAILED', 'SUBMITTED');

-- 24-hour cancellation window check (helper index)
CREATE INDEX idx_einv_ack_date ON e_invoice_details(ack_date)
    WHERE status = 'GENERATED' AND ack_date IS NOT NULL;

-------------------------------------------------------------------------------
-- 4. E-WAY BILL DETAILS
--    Generated after e-invoice IRN is obtained (Part-A from IRN).
--    Part-B (vehicle details) added separately.
-------------------------------------------------------------------------------
CREATE TABLE eway_bill_details (
    -- ── Primary Key ──
    eway_bill_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- ── Parent links ──
    e_invoice_id         BIGINT       REFERENCES e_invoice_details(e_invoice_id), -- linked e-invoice
    transaction_id       BIGINT       REFERENCES transactions(transaction_id),
    tenant_id            UUID         NOT NULL,
    gst_registration_id  BIGINT       NOT NULL REFERENCES gst_registrations(gst_registration_id),

    -- ── NIC Response ──
    ewb_no               VARCHAR(12),                           -- 12-digit E-Way Bill Number
    ewb_valid_until      TIMESTAMPTZ,                           -- validity based on distance
    generation_date      TIMESTAMPTZ,

    -- ── Supply Details ──
    supply_type          supply_type   NOT NULL DEFAULT 'B2B',
    sub_supply_type      VARCHAR(20)   DEFAULT 'SUPPLY',        -- SUPPLY, JOB_WORK, SKD_CKD, etc.
    document_type        VARCHAR(10)   DEFAULT 'INV',            -- INV, CHL, BIL, etc.
    document_number      VARCHAR(16),                           -- linked invoice/challan number
    document_date        DATE,

    -- ── PIN Codes (critical for distance calculation) ──
    dispatch_from_pin    VARCHAR(6)    NOT NULL,                -- Origin PIN code
    ship_to_pin          VARCHAR(6)    NOT NULL,                -- Destination PIN code

    -- ── Distance (mandatory for ROAD transport) ──
    approx_distance_km   NUMERIC(10,2),                          -- auto-calculated or user-provided
    distance_source      VARCHAR(20)    DEFAULT 'GOOGLE_MAPS',  -- GOOGLE_MAPS, PINCODE_MASTER, MANUAL
    distance_calc_response JSONB,                               -- raw API response for audit

    -- ── Transport ──
    transport_mode       transport_mode NOT NULL DEFAULT 'ROAD',
    vehicle_number       VARCHAR(15),                           -- e.g. 'MH02AB1234'
    transporter_id       VARCHAR(15),                            -- GSTIN of transporter (if any)

    -- ── JSON Payloads ──
    request_payload      JSONB         NOT NULL,
    response_payload     JSONB,
    nic_error_code       VARCHAR(50),
    nic_error_message    TEXT,

    -- ── Status ──
    status               eway_bill_status NOT NULL DEFAULT 'PENDING',
    status_history       JSONB         NOT NULL DEFAULT '[]'::jsonb,

    -- ── Cancellation ──
    cancelled_at         TIMESTAMPTZ,
    cancelled_reason     TEXT,

    -- ── Audit ──
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Lookup by NIC e-way bill number
CREATE INDEX idx_ewb_no ON eway_bill_details(ewb_no) WHERE ewb_no IS NOT NULL;

-- Queue processing
CREATE INDEX idx_ewb_status_queue ON eway_bill_details(status, updated_at)
    WHERE status IN ('QUEUED', 'FAILED');

-- Distance validation: NULL means not yet calculated
CREATE INDEX idx_ewb_distance ON eway_bill_details(status)
    WHERE approx_distance_km IS NULL AND status = 'PENDING';

-------------------------------------------------------------------------------
-- 5. API RETRY QUEUE
--    Generic queue for pushing invoices/eway-bills to government portals.
--    A cron job / BullMq worker sweeps this table and retries with backoff.
-------------------------------------------------------------------------------
CREATE TABLE api_retry_queue (
    retry_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Polymorphic reference to the owning entity
    entity_type        VARCHAR(20)   NOT NULL,                   -- 'E_INVOICE' | 'EWAY_BILL'
    entity_id          BIGINT        NOT NULL,
    operation          VARCHAR(30)   NOT NULL,                   -- 'GENERATE', 'CANCEL', 'EXTEND'
    tenant_id          UUID          NOT NULL,

    -- Where to send it
    gsp_credential_id  BIGINT        REFERENCES gsp_credentials(gsp_credential_id),
    endpoint_path      VARCHAR(500)  NOT NULL,                   -- relative API path on the GSP
    payload            JSONB         NOT NULL,                   -- the JSON to POST

    -- Retry state machine
    attempt_count      INT           NOT NULL DEFAULT 0,
    max_attempts       INT           NOT NULL DEFAULT 7,
    last_error_code    VARCHAR(50),
    last_error_body    JSONB,
    last_attempted_at  TIMESTAMPTZ,

    -- Exponential backoff: next_retry_at = last_attempted_at + 2^attempt_count seconds
    next_retry_at      TIMESTAMPTZ   NOT NULL,
    status             VARCHAR(20)   NOT NULL DEFAULT 'QUEUED'
                       CHECK (status IN ('QUEUED', 'IN_PROGRESS', 'SUCCESS', 'PERMANENTLY_FAILED')),

    created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Sweep query: get due items
CREATE INDEX idx_retry_due ON api_retry_queue(next_retry_at)
    WHERE status = 'QUEUED';

-- Per-entity dedup: one active retry per entity+operation
CREATE UNIQUE INDEX idx_retry_unique ON api_retry_queue(entity_type, entity_id, operation)
    WHERE status IN ('QUEUED', 'IN_PROGRESS');

-------------------------------------------------------------------------------
-- 6. PIN CODE MASTER (local fallback for distance auto-calculation)
--    Seeded with Indian PIN codes + lat/lng. Used when Google Maps API
--    is unavailable or as a fast first pass.
-------------------------------------------------------------------------------
CREATE TABLE pin_code_master (
    pin_code       VARCHAR(6)  PRIMARY KEY,
    city           VARCHAR(200),
    district       VARCHAR(200),
    state_code     VARCHAR(2)  REFERENCES state_master(state_code),
    latitude       NUMERIC(9,6),
    longitude      NUMERIC(10,6),
    is_verified    BOOLEAN     NOT NULL DEFAULT FALSE,            -- true if coordinates confirmed
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pin_state ON pin_code_master(state_code);

-------------------------------------------------------------------------------
-- 7. VALIDATION FUNCTIONS (DB-level guard rails)
-------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 7a. 24-HOUR CANCELLATION WINDOW CHECK
--     Returns FALSE if the 24h window has expired → force Credit Note.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_cancel_einvoice(
    p_e_invoice_id BIGINT,
    p_cancel_at    TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
    can_cancel   BOOLEAN,
    reason       TEXT,
    ack_dt       TIMESTAMPTZ,
    hours_elapsed NUMERIC(10,2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        (eid.ack_date IS NOT NULL)
            AND (p_cancel_at <= eid.ack_date + INTERVAL '24 hours')
            AND (eid.status = 'GENERATED') AS can_cancel,
        CASE
            WHEN eid.ack_date IS NULL
                THEN 'E-Invoice has no acknowledgement date (not yet generated by IRP)'
            WHEN eid.status <> 'GENERATED'
                THEN format('E-Invoice status is %s (must be GENERATED to cancel)', eid.status)
            WHEN p_cancel_at > eid.ack_date + INTERVAL '24 hours'
                THEN format(
                    '24-hour cancellation window expired (AckDt: %s, elapsed: %.1f hrs). Issue a Credit Note instead.',
                    eid.ack_date,
                    EXTRACT(EPOCH FROM (p_cancel_at - eid.ack_date)) / 3600
                )
            ELSE 'Cancellation allowed — within 24-hour window'
        END AS reason,
        eid.ack_date AS ack_dt,
        CASE
            WHEN eid.ack_date IS NOT NULL
                THEN ROUND(EXTRACT(EPOCH FROM (p_cancel_at - eid.ack_date)) / 3600, 2)
            ELSE 0
        END AS hours_elapsed
    FROM e_invoice_details eid
    WHERE eid.e_invoice_id = p_e_invoice_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE::BOOLEAN, 'E-Invoice not found', NULL::TIMESTAMPTZ, 0::NUMERIC(10,2);
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 7b. VALIDATE E-INVOICE DATA BEFORE SUBMISSION
--     Checks mandatory fields per INV-01 schema before queueing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_einvoice_for_submission(
    p_e_invoice_id BIGINT
)
RETURNS TABLE (
    is_valid  BOOLEAN,
    errors    TEXT[]
) AS $$
DECLARE
    v_errors TEXT[] := '{}';
    v_rec    RECORD;
BEGIN
    SELECT
        eid.e_invoice_id,
        eid.invoice_number,
        eid.invoice_date,
        eid.supply_type,
        eid.status,
        t.transaction_id AS txn_id,
        t.txn_date,
        t.metadata,
        gr.gstin,
        gr.state_code
    INTO v_rec
    FROM e_invoice_details eid
    JOIN transactions t ON t.transaction_id = eid.transaction_id
    JOIN gst_registrations gr ON gr.gst_registration_id = eid.gst_registration_id
    WHERE eid.e_invoice_id = p_e_invoice_id;

    IF NOT FOUND THEN
        v_errors := array_append(v_errors, 'E-Invoice record not found');
        RETURN QUERY SELECT FALSE, v_errors;
        RETURN;
    END IF;

    IF v_rec.invoice_number IS NULL OR LENGTH(v_rec.invoice_number) > 16 THEN
        v_errors := array_append(v_errors, 'Invoice number must be 1-16 characters');
    END IF;

    IF v_rec.invoice_date IS NULL THEN
        v_errors := array_append(v_errors, 'Invoice date is mandatory');
    END IF;

    IF v_rec.gstin IS NULL THEN
        v_errors := array_append(v_errors, 'Supplier GSTIN is missing in gst_registrations');
    END IF;

    -- Check: at least one tax_entry (OUTPUT) exists for this transaction
    IF NOT EXISTS (
        SELECT 1 FROM tax_entries te
        WHERE te.transaction_id = v_rec.txn_id
          AND te.tax_type = 'OUTPUT'
    ) THEN
        v_errors := array_append(v_errors, 'No OUTPUT tax entries found for this transaction');
    END IF;

    -- Check: status must be DRAFT or FAILED
    IF v_rec.status NOT IN ('DRAFT', 'FAILED') THEN
        v_errors := array_append(v_errors, format('Invalid status for submission: %s', v_rec.status));
    END IF;

    is_valid := (array_length(v_errors, 1) IS NULL);
    errors   := v_errors;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 7c. HAVERSINE DISTANCE (PIN to PIN via lat/lng)
--     Used as fallback when Google Maps API is down.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION haversine_distance_km(
    p_from_pin VARCHAR(6),
    p_to_pin   VARCHAR(6)
)
RETURNS NUMERIC(10,2) AS $$
DECLARE
    v_from_lat  NUMERIC(9,6);
    v_from_lng  NUMERIC(10,6);
    v_to_lat    NUMERIC(9,6);
    v_to_lng    NUMERIC(10,6);
    v_earth_r   NUMERIC := 6371;  -- km
    v_dlat      NUMERIC;
    v_dlng      NUMERIC;
    v_a         NUMERIC;
    v_c         NUMERIC;
BEGIN
    SELECT latitude, longitude INTO v_from_lat, v_from_lng
    FROM pin_code_master WHERE pin_code = p_from_pin;

    SELECT latitude, longitude INTO v_to_lat, v_to_lng
    FROM pin_code_master WHERE pin_code = p_to_pin;

    IF v_from_lat IS NULL OR v_to_lat IS NULL THEN
        RETURN NULL;
    END IF;

    -- Haversine formula
    v_dlat := RADIANS(v_to_lat - v_from_lat);
    v_dlng := RADIANS(v_to_lng - v_from_lng);
    v_a    := SIN(v_dlat / 2) * SIN(v_dlat / 2)
            + COS(RADIANS(v_from_lat)) * COS(RADIANS(v_to_lat))
              * SIN(v_dlng / 2) * SIN(v_dlng / 2);
    v_c    := 2 * ATAN2(SQRT(v_a), SQRT(1 - v_a));

    RETURN ROUND(v_earth_r * v_c, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-------------------------------------------------------------------------------
-- 8. TRIGGER — enforce 24-hour cancellation at DB level
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_block_overdue_cancellation()
RETURNS TRIGGER AS $$
DECLARE
    v_can_cancel BOOLEAN;
    v_reason     TEXT;
BEGIN
    -- Only enforce when status transitions TO 'CANCELLED'
    IF NEW.status = 'CANCELLED' AND (OLD.status IS NULL OR OLD.status <> 'CANCELLED') THEN
        -- Reload the can_cancel check from the function
        SELECT c.can_cancel, c.reason INTO v_can_cancel, v_reason
        FROM can_cancel_einvoice(NEW.e_invoice_id, NEW.cancelled_at) AS c;

        IF v_can_cancel IS NULL OR v_can_cancel = FALSE THEN
            RAISE EXCEPTION 'Cancellation blocked: %', v_reason
                USING HINT = 'The 24-hour cancellation window has expired. Generate a Credit Note via the accounting module instead.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_einvoice_cancel_guard
    BEFORE UPDATE OF status ON e_invoice_details
    FOR EACH ROW
    EXECUTE FUNCTION trg_block_overdue_cancellation();

-------------------------------------------------------------------------------
-- 9. HELPER — append to status_history JSONB
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION append_status_history(
    p_history   JSONB,
    p_status    TEXT,
    p_actor     VARCHAR(100) DEFAULT 'system'
)
RETURNS JSONB AS $$
BEGIN
    RETURN p_history || jsonb_build_object(
        'status',    p_status,
        'timestamp', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'actor',     p_actor
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;
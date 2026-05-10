-- ============================================================================
-- REFRESH TOKENS TABLE — for JWT auth token rotation
-- ============================================================================
CREATE TABLE refresh_tokens (
    token_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     BIGINT       NOT NULL,
    company_id  BIGINT       NOT NULL,
    token_hash  VARCHAR(128) NOT NULL UNIQUE,    -- SHA-256 of the actual refresh token

    -- Device / session info
    device_info VARCHAR(500),
    ip_address  INET,
    user_agent  VARCHAR(500),

    -- Lifecycle
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ,                     -- NULL = active
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,

    -- The access token family — all tokens in a family are invalidated on revocation
    token_family UUID         NOT NULL DEFAULT gen_random_uuid()
);

-- Fast lookup and cleanup
CREATE INDEX idx_refresh_tokens_user   ON refresh_tokens(user_id, company_id);
CREATE INDEX idx_refresh_tokens_hash   ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;
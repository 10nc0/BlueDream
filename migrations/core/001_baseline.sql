-- Core baseline: all shared tables and indexes.
-- Safe to run on existing deployments (IF NOT EXISTS everywhere).
-- Synthesized: forker's constraint/index improvements applied on top of
-- correct column names/types from live codebase (recorded_at, UUID book_registry.id,
-- TEXT message_queue.priority). All tables from original baseline preserved.

CREATE SCHEMA IF NOT EXISTS core;

-- Migration tracking (bootstrap creates these; kept here for documentation)
CREATE TABLE IF NOT EXISTS core.migrations (
    name TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.tenant_migrations (
    tenant_schema TEXT NOT NULL,
    name TEXT NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_schema, name)
);

-- Tenant registry
CREATE TABLE IF NOT EXISTS core.tenant_catalog (
    id              SERIAL PRIMARY KEY,
    tenant_schema   TEXT NOT NULL UNIQUE
                    CHECK (tenant_schema ~ '^[a-z_][a-z0-9_]*$'),
    genesis_user_id INTEGER,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Email → tenant lookup (cross-tenant index)
CREATE TABLE IF NOT EXISTS core.user_email_to_tenant (
    email         TEXT NOT NULL,
    tenant_id     INTEGER NOT NULL REFERENCES core.tenant_catalog(id) ON DELETE CASCADE,
    tenant_schema TEXT NOT NULL,
    user_id       INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (email)
);

CREATE INDEX IF NOT EXISTS user_email_to_tenant_lower_idx
    ON core.user_email_to_tenant (LOWER(email));

-- Invite tokens
CREATE TABLE IF NOT EXISTS core.invite_tokens (
    id          SERIAL PRIMARY KEY,
    token       TEXT UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_at TIMESTAMPTZ,
    consumed_by TEXT
);

-- Rate limiting: track signups per IP / email domain
CREATE TABLE IF NOT EXISTS core.tenant_creation_log (
    id         SERIAL PRIMARY KEY,
    email      TEXT NOT NULL,
    ip         TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_creation_log_email_idx
    ON core.tenant_creation_log (LOWER(email), created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_creation_log_ip_idx
    ON core.tenant_creation_log (ip, created_at DESC);

-- Book sharing (cross-tenant)
CREATE TABLE IF NOT EXISTS core.book_shares (
    id                SERIAL PRIMARY KEY,
    book_fractal_id   TEXT NOT NULL,
    owner_email       TEXT NOT NULL,
    shared_with_email TEXT NOT NULL,
    permission_level  TEXT NOT NULL DEFAULT 'viewer',
    invited_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS book_shares_unique_idx
    ON core.book_shares (book_fractal_id, LOWER(shared_with_email))
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_book_shares_book_id
    ON core.book_shares (book_fractal_id) WHERE revoked_at IS NULL;

-- Book registry (cross-tenant, routing table for inbound messages)
-- id is UUID — DO NOT change to SERIAL; packet-queue.js uses UUID joins.
-- heal_* columns are added by 003_compat_columns.sql — not here.
CREATE TABLE IF NOT EXISTS core.book_registry (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_name      TEXT NOT NULL,
    join_code      TEXT UNIQUE NOT NULL,
    fractal_id     TEXT UNIQUE NOT NULL,
    tenant_schema  TEXT NOT NULL,
    tenant_email   TEXT NOT NULL,
    phone_number   TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'active', 'inactive', 'suspended')),
    inpipe_type    TEXT DEFAULT 'whatsapp',
    outpipe_ledger TEXT NOT NULL,
    outpipes_user  JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at   TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    creator_phone  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_registry_join_code
    ON core.book_registry (LOWER(join_code));
CREATE INDEX IF NOT EXISTS idx_book_registry_tenant_schema
    ON core.book_registry (tenant_schema);
CREATE INDEX IF NOT EXISTS idx_book_registry_fractal_id
    ON core.book_registry (fractal_id);
CREATE INDEX IF NOT EXISTS idx_book_registry_status
    ON core.book_registry (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_book_registry_tenant_book
    ON core.book_registry (tenant_schema, id);

-- Phones that have interacted with a book
CREATE TABLE IF NOT EXISTS core.book_engaged_phones (
    book_registry_id UUID NOT NULL REFERENCES core.book_registry(id) ON DELETE CASCADE,
    phone            TEXT NOT NULL,
    is_creator       BOOLEAN NOT NULL DEFAULT FALSE,
    first_engaged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_engaged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (book_registry_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_phone
    ON core.book_engaged_phones (phone);
CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_last_engaged
    ON core.book_engaged_phones (phone, last_engaged_at DESC);

-- Channel identifier routing (e.g. Telegram chat_id → book)
-- Composite PK replaces SERIAL id + UNIQUE constraint.
CREATE TABLE IF NOT EXISTS core.channel_identifiers (
    channel         TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    book_fractal_id TEXT NOT NULL,
    tenant_schema   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_identifiers_book
    ON core.channel_identifiers (book_fractal_id);

-- Append-only message ledger (immutable provenance record)
-- recorded_at — DO NOT rename to created_at; packet-queue.js inserts use recorded_at.
-- env and detected_lang are added by 003_compat_columns.sql — not here.
CREATE TABLE IF NOT EXISTS core.message_ledger (
    message_fractal_id   TEXT        PRIMARY KEY,
    book_fractal_id      TEXT        NOT NULL,
    ipfs_cid             TEXT,
    sender_hash          TEXT        NOT NULL,
    content_hash         TEXT        NOT NULL,
    has_attachment       BOOLEAN     NOT NULL DEFAULT FALSE,
    attachment_disclosed BOOLEAN     NOT NULL DEFAULT TRUE,
    attachment_cid       TEXT,
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_ledger_book
    ON core.message_ledger (book_fractal_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_ledger_ipfs
    ON core.message_ledger (ipfs_cid) WHERE ipfs_cid IS NOT NULL;

-- Password reset tokens
CREATE TABLE IF NOT EXISTS core.password_reset_tokens (
    id            SERIAL PRIMARY KEY,
    token         TEXT UNIQUE NOT NULL,
    user_email    TEXT NOT NULL,
    tenant_schema TEXT NOT NULL,
    phone         TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    used          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token
    ON core.password_reset_tokens (token);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
    ON core.password_reset_tokens (LOWER(user_email)) WHERE used = FALSE;

-- System-wide counters (phi-breathe heartbeat, etc.)
-- key is the natural PK; id column not used in queries.
CREATE TABLE IF NOT EXISTS core.system_counters (
    key        TEXT PRIMARY KEY,
    value      BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO core.system_counters (key, value)
    VALUES ('phi_breathe_count', 0)
    ON CONFLICT (key) DO NOTHING;

-- Inbound message queue (worker-processed)
-- priority is TEXT ('media' | 'text') — DO NOT change to INTEGER;
-- packet-queue.js inserts string values and dequeues with string CASE.
CREATE TABLE IF NOT EXISTS core.message_queue (
    id          SERIAL PRIMARY KEY,
    priority    TEXT NOT NULL DEFAULT 'text',
    payload     JSONB NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_queue_dequeue_idx
    ON core.message_queue (status, priority, created_at)
    WHERE status = 'pending';

-- Deduplication: processed incoming message SIDs (Twilio / LINE)
CREATE TABLE IF NOT EXISTS core.processed_sids (
    sid          TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS processed_sids_processed_at_idx
    ON core.processed_sids (processed_at);

-- Playground usage tracking (per-day, per-service-type)
CREATE TABLE IF NOT EXISTS core.playground_usage (
    id                SERIAL PRIMARY KEY,
    date              DATE NOT NULL,
    service_type      TEXT NOT NULL,
    requests          INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, service_type)
);

CREATE INDEX IF NOT EXISTS idx_playground_usage_date
    ON core.playground_usage (date);

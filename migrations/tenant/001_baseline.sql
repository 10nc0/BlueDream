-- Tenant baseline: all per-tenant tables and indexes.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.
-- Synthesized: forker's constraint/index improvements (LOWER() email index,
-- CHECK on role enum, NOT NULL tightening, FK ON DELETE discipline) applied
-- on top of the full table set from the original baseline.
-- agent_token_hash is NOT here — it is added by 002_agent_token.sql.

CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

-- Tenant users
CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
    id               SERIAL PRIMARY KEY,
    email            TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    role             TEXT NOT NULL DEFAULT 'admin'
                     CHECK (role IN ('admin', 'write-only', 'read-only')),
    tenant_id        INTEGER NOT NULL,
    is_genesis_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_lower_email_idx
    ON ${SCHEMA}.users (LOWER(email));

-- Refresh tokens (JWT rotation)
CREATE TABLE IF NOT EXISTS ${SCHEMA}.refresh_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    device_info TEXT,
    ip_address  TEXT,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ,
    is_revoked  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
    ON ${SCHEMA}.refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Books (information channels)
-- agent_token_hash added by 002_agent_token.sql — not here.
-- created_by_admin_id is TEXT (stores email or legacy id) — do not change to FK.
CREATE TABLE IF NOT EXISTS ${SCHEMA}.books (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    input_platform      TEXT NOT NULL,
    output_platform     TEXT NOT NULL,
    input_credentials   JSONB,
    output_credentials  JSONB,
    output_01_url       TEXT,
    output_0n_url       TEXT,
    status              TEXT NOT NULL DEFAULT 'inactive'
                        CHECK (status IN ('inactive', 'pending', 'active', 'suspended')),
    contact_info        TEXT,
    tags                TEXT[] NOT NULL DEFAULT '{}',
    archived            BOOLEAN NOT NULL DEFAULT FALSE,
    fractal_id          TEXT,
    created_by_admin_id TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    outpipes_user       JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Book channel routing (Telegram inpipe, Discord outpipe, etc.)
CREATE TABLE IF NOT EXISTS ${SCHEMA}.book_channels (
    id              SERIAL PRIMARY KEY,
    book_fractal_id TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('inpipe', 'outpipe')),
    channel         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('active', 'placeholder', 'pending', 'inactive')),
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    priority        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (book_fractal_id, direction, channel)
);

CREATE INDEX IF NOT EXISTS book_channels_fractal_idx
    ON ${SCHEMA}.book_channels (book_fractal_id);

-- Discord message archive
CREATE TABLE IF NOT EXISTS ${SCHEMA}.drops (
    id                 SERIAL PRIMARY KEY,
    book_id            INTEGER NOT NULL REFERENCES ${SCHEMA}.books(id) ON DELETE CASCADE,
    discord_message_id TEXT NOT NULL,
    metadata_text      TEXT NOT NULL,
    extracted_tags     TEXT[] NOT NULL DEFAULT '{}',
    extracted_dates    TEXT[] NOT NULL DEFAULT '{}',
    search_vector      tsvector,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS drops_book_message_idx
    ON ${SCHEMA}.drops (book_id, discord_message_id);
CREATE INDEX IF NOT EXISTS drops_search_idx
    ON ${SCHEMA}.drops USING gin(search_vector);

-- Per-tenant session store (connect-pg-simple)
CREATE TABLE IF NOT EXISTS ${SCHEMA}.sessions (
    sid     TEXT PRIMARY KEY,
    sess    JSONB NOT NULL,
    expires TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expire_idx
    ON ${SCHEMA}.sessions (expires);

-- Audit log
CREATE TABLE IF NOT EXISTS ${SCHEMA}.audit_logs (
    id            SERIAL PRIMARY KEY,
    actor_user_id INTEGER,
    action_type   TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    details       JSONB,
    ip_address    TEXT,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
    ON ${SCHEMA}.audit_logs (actor_user_id, created_at DESC);

-- Media buffer (pre-ledger attachment staging)
CREATE TABLE IF NOT EXISTS ${SCHEMA}.media_buffer (
    id                     SERIAL PRIMARY KEY,
    book_id                INTEGER NOT NULL REFERENCES ${SCHEMA}.books(id) ON DELETE CASCADE,
    media_data             BYTEA NOT NULL,
    media_type             TEXT NOT NULL,
    filename               TEXT NOT NULL,
    sender_name            TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_to_ledger    BOOLEAN NOT NULL DEFAULT FALSE,
    delivered_to_user      BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_attempts      INTEGER NOT NULL DEFAULT 0,
    last_delivery_attempt  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS media_buffer_book_idx
    ON ${SCHEMA}.media_buffer (book_id, delivered_to_ledger, created_at);

-- Active sessions (device management)
CREATE TABLE IF NOT EXISTS ${SCHEMA}.active_sessions (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL UNIQUE,
    ip_address    TEXT,
    user_agent    TEXT,
    device_type   TEXT,
    browser       TEXT,
    os            TEXT,
    location      TEXT,
    login_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS active_sessions_user_idx
    ON ${SCHEMA}.active_sessions (user_id, is_active, last_activity DESC);

-- Message analytics (per-book, per-day counters)
CREATE TABLE IF NOT EXISTS ${SCHEMA}.message_analytics (
    id            SERIAL PRIMARY KEY,
    book_id       INTEGER NOT NULL REFERENCES ${SCHEMA}.books(id) ON DELETE CASCADE,
    date          DATE NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    media_count   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (book_id, date)
);

-- Phone-to-book routing
CREATE TABLE IF NOT EXISTS ${SCHEMA}.phone_to_book (
    id           SERIAL PRIMARY KEY,
    phone_number TEXT,
    book_id      INTEGER NOT NULL REFERENCES ${SCHEMA}.books(id) ON DELETE CASCADE,
    join_code    TEXT UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS phone_to_book_phone_book_idx
    ON ${SCHEMA}.phone_to_book (phone_number, book_id)
    WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_to_book_join_code_idx
    ON ${SCHEMA}.phone_to_book (join_code);

-- AI audit query log
CREATE TABLE IF NOT EXISTS ${SCHEMA}.audit_queries (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
    book_id             INTEGER REFERENCES ${SCHEMA}.books(id) ON DELETE SET NULL,
    rule_type           TEXT NOT NULL,
    language            TEXT NOT NULL DEFAULT 'en',
    input_messages      JSONB NOT NULL,
    result_status       TEXT NOT NULL,
    result_confidence   NUMERIC(4,3),
    result_reason       TEXT,
    result_data         JSONB,
    raw_response        TEXT,
    processing_time_ms  INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_queries_user_idx
    ON ${SCHEMA}.audit_queries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_queries_book_idx
    ON ${SCHEMA}.audit_queries (book_id, created_at DESC);

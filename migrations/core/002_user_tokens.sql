-- @nontransactional
-- core/002: user-level API tokens, contributor access grants, email change tokens,
--           and nullable phone on password_reset_tokens for authenticated reset flow.

-- Allow authenticated password resets without phone (session is the auth factor)
ALTER TABLE core.password_reset_tokens ALTER COLUMN phone DROP NOT NULL;

-- User-level bearer tokens (read-only cross-book access within own tenant)
CREATE TABLE IF NOT EXISTS core.user_tokens (
    id              SERIAL PRIMARY KEY,
    tenant_schema   TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_token_per_email
    ON core.user_tokens (tenant_schema, user_email);

-- Contributor access grants (admin grants access on specific books to an external email)
CREATE TABLE IF NOT EXISTS core.contributor_tokens (
    id                  SERIAL PRIMARY KEY,
    tenant_schema       TEXT NOT NULL,
    granted_by_email    TEXT NOT NULL,
    granted_to_email    TEXT NOT NULL,
    book_fractal_ids    TEXT[] NOT NULL DEFAULT '{}',
    token_hash          TEXT NOT NULL UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at        TIMESTAMPTZ,
    CONSTRAINT uq_contributor_per_pair UNIQUE (tenant_schema, granted_by_email, granted_to_email)
);

CREATE INDEX IF NOT EXISTS idx_contributor_tokens_hash
    ON core.contributor_tokens (token_hash);

-- Email change request tokens (24-hour TTL, single-use)
CREATE TABLE IF NOT EXISTS core.email_change_tokens (
    id              SERIAL PRIMARY KEY,
    tenant_schema   TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    new_email       TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_hash
    ON core.email_change_tokens (token_hash) WHERE used = FALSE;

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_email
    ON core.email_change_tokens (LOWER(user_email)) WHERE used = FALSE;

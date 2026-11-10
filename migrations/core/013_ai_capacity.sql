-- Shared admission and reservations; never store prompts or private media here.
CREATE TABLE IF NOT EXISTS core.ai_capacity (
  key TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS core.ai_reservations (
  id UUID PRIMARY KEY,
  principal TEXT NOT NULL,
  scopes JSONB NOT NULL,
  tokens BIGINT NOT NULL,
  cost NUMERIC NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  settled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ai_reservations_expiry ON core.ai_reservations(expires_at);
CREATE TABLE IF NOT EXISTS core.ai_audit_requests (
  key TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  state TEXT NOT NULL,
  result JSONB,
  expires_at TIMESTAMPTZ NOT NULL
);

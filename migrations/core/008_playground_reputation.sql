-- Migration 008: playground_reputation table
-- Extracts inline DDL from utils/playground-capacity.js into the migration system.
-- initReputationTable() in playground-capacity.js is now a no-op — this migration
-- creates the table on every fresh install and existing deployment that hasn't run it.
CREATE TABLE IF NOT EXISTS core.playground_reputation (
    ip_hash       VARCHAR(32) PRIMARY KEY,
    first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_queries INTEGER     NOT NULL DEFAULT 0,
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    blocked_until TIMESTAMPTZ
);

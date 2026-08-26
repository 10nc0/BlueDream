-- Migration 009: Add agent_token_hash to core.book_registry for O(1)
-- cross-tenant token lookup.
--
-- The agent_token_hash column already exists on tenant_N.books (per-tenant).
-- This column mirrors it at the core level so the token-based write route
-- (POST /api/agent/message — Task #206) can resolve fractal_id + tenant_schema
-- from a single Bearer token without scanning every tenant schema.
--
-- Sync responsibility: routes/books/agent.js keeps both columns in agreement
-- when tokens are generated (POST) or revoked (DELETE). The unique partial
-- index prevents two books sharing the same token hash (impossible in practice
-- given 256-bit key space, but enforced at DB level for defence-in-depth).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; CREATE UNIQUE INDEX IF NOT EXISTS.

ALTER TABLE core.book_registry
    ADD COLUMN IF NOT EXISTS agent_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_registry_agent_token
    ON core.book_registry (agent_token_hash)
    WHERE agent_token_hash IS NOT NULL;

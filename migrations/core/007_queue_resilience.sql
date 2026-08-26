-- Migration 007: Queue resilience — last_error column for dead-letter visibility
-- Stores the error message on permanent failure (status='failed', retry_count >= MAX_RETRY_COUNT).
-- Operators can inspect failed rows and requeue them via:
--   UPDATE core.message_queue SET status='pending', retry_count=0, last_error=NULL
--   WHERE status='failed' [AND payload->>'fractalId' = '...'];
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS last_error TEXT;

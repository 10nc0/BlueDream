-- Migration 011: Outbox reliability — raise max_attempts default + delivery index
--
-- max_attempts raised from whatever the old default was to 20.
-- With exponential backoff capped at 1 hour, 20 attempts provides 10+ hours of
-- retry coverage — a webhook can be down for a full work cycle and still recover.
--
-- Index on (status, next_attempt_at) matches the exact WHERE + ORDER BY shape
-- the outbox worker polls every 3 seconds; prevents sequential scan on busy tables.
--
-- Both changes are idempotent and safe to re-run on existing deployments.

ALTER TABLE core.outbox_jobs ALTER COLUMN max_attempts SET DEFAULT 20;

UPDATE core.outbox_jobs
SET max_attempts = 20
WHERE max_attempts < 20
  AND status = 'pending';

CREATE INDEX IF NOT EXISTS outbox_jobs_pending_idx
    ON core.outbox_jobs (status, next_attempt_at)
    WHERE status = 'pending';

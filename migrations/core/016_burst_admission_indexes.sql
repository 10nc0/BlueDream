-- Preserve legacy idempotency without scanning retained history for every new
-- webhook. New provider keys already have a unique partial index.
CREATE INDEX IF NOT EXISTS message_queue_legacy_provider_idx
    ON core.message_queue ((payload->>'channel'),
        (COALESCE(payload->>'messageSid',payload->'msg'->>'messageId')))
    WHERE provider_key IS NULL;
CREATE INDEX IF NOT EXISTS message_queue_backlog_idx
    ON core.message_queue(status) WHERE status IN ('pending','processing');

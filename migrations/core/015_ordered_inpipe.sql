-- Additive queue metadata. No queued packets or ledger history are rewritten.
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS conversation_key TEXT;
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS provider_key TEXT;
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE core.message_queue ADD COLUMN IF NOT EXISTS delivery_state JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS message_queue_provider_key_idx
    ON core.message_queue(provider_key) WHERE provider_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_queue_conversation_idx
    ON core.message_queue(conversation_key,id) WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS message_queue_ready_ingress_idx
    ON core.message_queue(id) WHERE status = 'pending';

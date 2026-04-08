-- Add phi_breathe_stamp to drops and anatta_messages.
-- Add drop_events table for typed absence tracking (tag/date removals).
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

ALTER TABLE ${SCHEMA}.drops
    ADD COLUMN IF NOT EXISTS phi_breathe_stamp INTEGER;

ALTER TABLE ${SCHEMA}.anatta_messages
    ADD COLUMN IF NOT EXISTS phi_breathe_stamp INTEGER;

CREATE TABLE IF NOT EXISTS ${SCHEMA}.drop_events (
    id                 SERIAL PRIMARY KEY,
    book_id            INTEGER NOT NULL REFERENCES ${SCHEMA}.books(id) ON DELETE CASCADE,
    discord_message_id TEXT    NOT NULL,
    event_type         TEXT    NOT NULL,
    event_data         JSONB   NOT NULL DEFAULT '{}',
    performed_by       TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS drop_events_book_msg_idx
    ON ${SCHEMA}.drop_events (book_id, discord_message_id, created_at DESC);

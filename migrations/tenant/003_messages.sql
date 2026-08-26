-- Anatta node mesh: plaintext message store for PostgreSQL agent read path.
-- Append-only from deploy date — no backfill of historical messages.
-- Uses `anatta_messages` name to avoid collision with any legacy `messages` tables.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

CREATE TABLE IF NOT EXISTS ${SCHEMA}.anatta_messages (
    id                 SERIAL PRIMARY KEY,
    book_fractal_id    TEXT        NOT NULL,
    message_fractal_id TEXT        UNIQUE,
    sender_name        TEXT,
    body               TEXT,
    has_attachment     BOOLEAN     DEFAULT false,
    attachment_cid     TEXT,
    media_url          TEXT,
    recorded_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS anatta_messages_book_recorded_idx
    ON ${SCHEMA}.anatta_messages (book_fractal_id, recorded_at DESC);

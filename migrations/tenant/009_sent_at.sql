-- Task #208: Add sent_at column to drops and anatta_messages.
-- sent_at carries the authoritative origination time from the inpipe
-- (e.g. Twilio DateCreated for WhatsApp).  Nullable so existing rows are
-- unaffected; reads use COALESCE(sent_at, created_at/recorded_at) so the
-- fallback to server insertion time is seamless for legacy rows.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

ALTER TABLE ${SCHEMA}.drops
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

ALTER TABLE ${SCHEMA}.anatta_messages
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Composite index covering the COALESCE sort used by read queries.
CREATE INDEX IF NOT EXISTS drops_sent_at_idx
    ON ${SCHEMA}.drops (book_id, COALESCE(sent_at, created_at) DESC);

CREATE INDEX IF NOT EXISTS anatta_messages_sent_at_idx
    ON ${SCHEMA}.anatta_messages (book_fractal_id, COALESCE(sent_at, recorded_at) DESC);

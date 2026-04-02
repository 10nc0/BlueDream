-- Full-text search on anatta_messages.
-- Adds a generated tsvector column (body + sender_name) and a GIN index.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.
--
-- Note: no CONCURRENTLY — migration runner sends multi-statement SQL in a single
-- pool.query() call which PostgreSQL wraps in an implicit transaction, blocking
-- CONCURRENTLY. Standard CREATE INDEX is safe at startup on all supported table sizes.

ALTER TABLE ${SCHEMA}.anatta_messages
    ADD COLUMN IF NOT EXISTS fts_vector tsvector
        GENERATED ALWAYS AS (
            to_tsvector('simple',
                coalesce(body, '') || ' ' || coalesce(sender_name, ''))
        ) STORED;

CREATE INDEX IF NOT EXISTS anatta_messages_fts_idx
    ON ${SCHEMA}.anatta_messages USING GIN (fts_vector);

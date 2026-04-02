-- Full-text search on anatta_messages.
-- Adds a generated tsvector column (body + sender_name) and a GIN index.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.
--
-- CONCURRENTLY: no explicit BEGIN/COMMIT → runs in autocommit mode, which
-- is required for CREATE INDEX CONCURRENTLY. Safe on tables with existing rows.

ALTER TABLE ${SCHEMA}.anatta_messages
    ADD COLUMN IF NOT EXISTS fts_vector tsvector
        GENERATED ALWAYS AS (
            to_tsvector('simple',
                coalesce(body, '') || ' ' || coalesce(sender_name, ''))
        ) STORED;

CREATE INDEX CONCURRENTLY IF NOT EXISTS anatta_messages_fts_idx
    ON ${SCHEMA}.anatta_messages USING GIN (fts_vector);

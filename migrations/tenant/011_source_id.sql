-- PITA-AOP (#243): Rename discord_message_id → source_id in drops and drop_events.
-- Column rename is non-destructive: existing Discord snowflake values remain valid strings.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

DO $$ BEGIN
    ALTER TABLE ${SCHEMA}.drops RENAME COLUMN discord_message_id TO source_id;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ${SCHEMA}.drop_events RENAME COLUMN discord_message_id TO source_id;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DROP INDEX IF EXISTS ${SCHEMA}.drops_book_message_idx;

CREATE UNIQUE INDEX IF NOT EXISTS drops_book_source_idx
    ON ${SCHEMA}.drops (book_id, source_id);

DROP INDEX IF EXISTS ${SCHEMA}.drop_events_book_msg_idx;

CREATE INDEX IF NOT EXISTS drop_events_book_source_idx
    ON ${SCHEMA}.drop_events (book_id, source_id, created_at DESC);

COMMENT ON TABLE ${SCHEMA}.drops IS 'Universal payload store (PITA-AOP)';

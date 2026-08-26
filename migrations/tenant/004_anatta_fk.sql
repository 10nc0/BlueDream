-- Anatta node mesh: add nullable FK from anatta_messages.message_fractal_id
-- to core.message_ledger(message_fractal_id).
--
-- Nullable: rows written by the webhook path before this migration had NULL
-- message_fractal_id; those rows remain valid.  Any non-NULL value must now
-- match a ledger entry, enforcing the verifiability chain.
--
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

DO $$
BEGIN
    ALTER TABLE ${SCHEMA}.anatta_messages
        ADD CONSTRAINT anatta_messages_ledger_fk
        FOREIGN KEY (message_fractal_id)
        REFERENCES core.message_ledger(message_fractal_id)
        ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

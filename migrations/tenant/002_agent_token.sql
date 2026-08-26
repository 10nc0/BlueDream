ALTER TABLE ${SCHEMA}.books ADD COLUMN IF NOT EXISTS agent_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS books_agent_token_hash_idx ON ${SCHEMA}.books (agent_token_hash) WHERE agent_token_hash IS NOT NULL;

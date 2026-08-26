-- Boot-time self-retirement flag store.
-- One-shot boot jobs (backfill_agent_tokens, normalize_output_credentials, etc.)
-- write a row here after completing with zero work, and check for it on every
-- subsequent boot to skip the full tenant scan (O(1) instead of O(N)).
-- Rows are never deleted automatically — a manual DELETE resets the job for the
-- next boot (useful after a bulk data restore or tenant schema change).

CREATE TABLE IF NOT EXISTS core.boot_flags (
    key          TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.outbox_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_fractal_id TEXT NOT NULL,
    tenant_schema   TEXT NOT NULL,
    capsule_id      TEXT,
    outpipe_type    TEXT NOT NULL,
    outpipe_name    TEXT,
    endpoint        TEXT,
    payload         JSONB NOT NULL,
    outpipe_config  JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_jobs_pending_idx
    ON core.outbox_jobs (next_attempt_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS outbox_jobs_book_idx
    ON core.outbox_jobs (book_fractal_id)
    WHERE status = 'pending';

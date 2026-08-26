-- Onboarding state is one row per tenant user.
CREATE TABLE IF NOT EXISTS ${SCHEMA}.user_settings (
    user_id              INTEGER PRIMARY KEY REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
    onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
    settings             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
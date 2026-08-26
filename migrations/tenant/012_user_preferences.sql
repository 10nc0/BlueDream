-- tenant/012: add preferences JSONB column to users table
-- Stores per-user settings: locale, monthlyEmailBackupDefault, etc.
ALTER TABLE ${SCHEMA}.users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';

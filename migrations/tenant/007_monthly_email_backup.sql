-- Per-book monthly email backup opt-in flag.
-- When TRUE (default), the book's messages are included in the monthly
-- email digest sent to the tenant admin.
-- When FALSE, the book is silently skipped.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

ALTER TABLE ${SCHEMA}.books
    ADD COLUMN IF NOT EXISTS monthly_email_backup BOOLEAN NOT NULL DEFAULT TRUE;

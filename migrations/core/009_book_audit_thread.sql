-- 009_book_audit_thread.sql
-- Per-book Discord audit thread coordinate.
-- Each book gets its own thread; provisioned atomically on first audit write.
-- NULL = no audit written yet (pre-migration or brand-new book).
-- Tenant-level ai_log_thread_id is retained for monthly closing events only.

ALTER TABLE core.book_registry
    ADD COLUMN IF NOT EXISTS audit_thread_id TEXT;

COMMENT ON COLUMN core.book_registry.audit_thread_id IS
    'Discord thread ID for this book''s per-book AI audit log. Provisioned atomically-lazily on first audit write. NULL = no audit written yet.';

-- Audit route metadata added after the original core baseline.
ALTER TABLE core.book_registry
    ADD COLUMN IF NOT EXISTS audit_thread_id TEXT;

ALTER TABLE core.tenant_catalog
    ADD COLUMN IF NOT EXISTS audit_mirror_webhook_url TEXT;
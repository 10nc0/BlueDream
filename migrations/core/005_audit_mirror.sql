ALTER TABLE core.tenant_catalog ADD COLUMN IF NOT EXISTS ai_log_thread_id TEXT;
ALTER TABLE core.tenant_catalog ADD COLUMN IF NOT EXISTS ai_log_channel_id TEXT;
ALTER TABLE core.tenant_catalog ADD COLUMN IF NOT EXISTS audit_mirror_thread_id TEXT;
ALTER TABLE core.tenant_catalog ADD COLUMN IF NOT EXISTS audit_mirror_channel_id TEXT;

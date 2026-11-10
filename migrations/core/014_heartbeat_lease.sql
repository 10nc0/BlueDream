-- Transaction-pooler-safe heartbeat ownership and existing mesh snapshots.
ALTER TABLE core.system_counters ADD COLUMN IF NOT EXISTS meta JSONB;

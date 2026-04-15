-- 010_system_counters_meta.sql
-- Add meta JSONB column to core.system_counters for non-numeric payloads
-- (e.g., NyanMesh node registry snapshot). value BIGINT remains for numeric keys.
ALTER TABLE core.system_counters
    ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT NULL;

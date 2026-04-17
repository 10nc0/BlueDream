-- 010_system_counters_meta.sql
-- Add meta JSONB column to core.system_counters for non-numeric payloads.
-- Used by NyanMesh node registry snapshot (key='mesh_node_registry').
-- value BIGINT remains for numeric counters; meta is NULL for those rows.
ALTER TABLE core.system_counters
    ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT NULL;

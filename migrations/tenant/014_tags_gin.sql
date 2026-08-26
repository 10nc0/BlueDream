-- tenant/014: GIN index on extracted_tags + lowercase normalisation backfill.
--
-- drop-writer.js dedupTags() has always stored tags in lowercase since the PITA
-- mesh was introduced.  This backfill is a safety net for any rows written via
-- a code path that bypassed dedupTags (e.g. direct SQL, legacy imports).
-- The UPDATE is idempotent: it only touches rows that have at least one tag
-- that is not already lowercase.
--
-- The GIN index makes @> containment queries (mesh tag search) index-driven
-- instead of sequential scans.

UPDATE ${SCHEMA}.drops
SET extracted_tags = ARRAY(SELECT lower(t) FROM unnest(extracted_tags) t)
WHERE EXISTS (
    SELECT 1 FROM unnest(extracted_tags) t WHERE lower(t) <> t
);

CREATE INDEX IF NOT EXISTS drops_tags_gin
    ON ${SCHEMA}.drops USING gin(extracted_tags);

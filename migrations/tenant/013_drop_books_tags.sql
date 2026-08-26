-- tenant/013: remove stained-glass book-level tags column
-- Tags are federated from drops.extracted_tags via the PITA mesh (GET /api/mesh/tag/:tagValue).
-- Book-level tags were an anti-pattern; this column is now obsolete.
ALTER TABLE ${SCHEMA}.books DROP COLUMN IF EXISTS tags;

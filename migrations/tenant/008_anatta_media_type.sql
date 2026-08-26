-- Persist message media MIME type for richer monthly email tallies.
-- Existing rows: backfill from media_url filename extension where possible
-- (lossy — query-stringed CDN URLs without a clean extension stay NULL).
-- New rows: populated at INSERT time in lib/packet-queue.js, sourced from
-- Discord's attachment content_type when available, else url-derived.
-- ${SCHEMA} is replaced at runtime with the actual tenant schema name.

ALTER TABLE ${SCHEMA}.anatta_messages
    ADD COLUMN IF NOT EXISTS media_type TEXT;

-- One-time backfill — derive a synthetic MIME from the URL's filename
-- extension. Strips query strings (?ex=…&is=…) before extracting the
-- last "." segment. Only touches rows where:
--   1. has_attachment = TRUE (no point deriving for text-only messages)
--   2. media_url IS NOT NULL (need a URL to extract from)
--   3. media_type IS NULL (idempotent — never overwrites)
UPDATE ${SCHEMA}.anatta_messages
SET media_type = CASE lower(
    substring(
        regexp_replace(media_url, '\?.*$', '')
        FROM '\.([a-zA-Z0-9]+)$'
    )
)
    WHEN 'jpg'  THEN 'image/jpeg'
    WHEN 'jpeg' THEN 'image/jpeg'
    WHEN 'png'  THEN 'image/png'
    WHEN 'gif'  THEN 'image/gif'
    WHEN 'webp' THEN 'image/webp'
    WHEN 'svg'  THEN 'image/svg+xml'
    WHEN 'bmp'  THEN 'image/bmp'
    WHEN 'tiff' THEN 'image/tiff'
    WHEN 'tif'  THEN 'image/tiff'
    WHEN 'heic' THEN 'image/heic'
    WHEN 'heif' THEN 'image/heif'
    WHEN 'avif' THEN 'image/avif'
    WHEN 'ico'  THEN 'image/x-icon'
    WHEN 'mp4'  THEN 'video/mp4'
    WHEN 'mov'  THEN 'video/quicktime'
    WHEN 'avi'  THEN 'video/x-msvideo'
    WHEN 'mkv'  THEN 'video/x-matroska'
    WHEN 'webm' THEN 'video/webm'
    WHEN 'wmv'  THEN 'video/x-ms-wmv'
    WHEN 'flv'  THEN 'video/x-flv'
    WHEN 'm4v'  THEN 'video/x-m4v'
    WHEN '3gp'  THEN 'video/3gpp'
    WHEN 'mp3'  THEN 'audio/mpeg'
    WHEN 'wav'  THEN 'audio/wav'
    WHEN 'ogg'  THEN 'audio/ogg'
    WHEN 'oga'  THEN 'audio/ogg'
    WHEN 'opus' THEN 'audio/opus'
    WHEN 'm4a'  THEN 'audio/mp4'
    WHEN 'aac'  THEN 'audio/aac'
    WHEN 'flac' THEN 'audio/flac'
    WHEN 'wma'  THEN 'audio/x-ms-wma'
    WHEN 'pdf'  THEN 'application/pdf'
    WHEN 'doc'  THEN 'application/msword'
    WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    WHEN 'xls'  THEN 'application/vnd.ms-excel'
    WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    WHEN 'ppt'  THEN 'application/vnd.ms-powerpoint'
    WHEN 'pptx' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    WHEN 'odt'  THEN 'application/vnd.oasis.opendocument.text'
    WHEN 'ods'  THEN 'application/vnd.oasis.opendocument.spreadsheet'
    WHEN 'odp'  THEN 'application/vnd.oasis.opendocument.presentation'
    WHEN 'rtf'  THEN 'application/rtf'
    WHEN 'txt'  THEN 'text/plain'
    WHEN 'csv'  THEN 'text/csv'
    WHEN 'md'   THEN 'text/markdown'
    WHEN 'zip'  THEN 'application/zip'
    WHEN 'rar'  THEN 'application/vnd.rar'
    WHEN '7z'   THEN 'application/x-7z-compressed'
    WHEN 'tar'  THEN 'application/x-tar'
    WHEN 'gz'   THEN 'application/gzip'
    ELSE NULL
END
WHERE has_attachment = TRUE
  AND media_url IS NOT NULL
  AND media_type IS NULL;

CREATE INDEX IF NOT EXISTS anatta_messages_media_type_idx
    ON ${SCHEMA}.anatta_messages (media_type)
    WHERE media_type IS NOT NULL;

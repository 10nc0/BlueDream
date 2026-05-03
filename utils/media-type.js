'use strict';

// Two small helpers used by both the message-write pipeline (packet-queue)
// and the monthly-email tally renderer (monthly-closing + monthly-email):
//
//   urlToMime(url):       'https://cdn.../foo.jpg?ex=...' → 'image/jpeg'
//                         Returns null if no clean extension can be derived.
//                         Used at INSERT time as the fallback when the source
//                         channel didn't provide an authoritative content_type
//                         (Discord does, LINE / WhatsApp / Telegram usually
//                         don't via the URL alone).
//
//   mimeToBucket(mime):   'image/jpeg' → 'image'
//                         'application/pdf' → 'document'
//                         Used at render time to fold raw MIMEs into the six
//                         display buckets shown in the monthly email.
//                         Returns 'other' for unknown MIMEs (so we never
//                         silently lose an attachment from the breakdown).
//
// Keep these tables in lock-step with the backfill CASE in
// migrations/tenant/008_anatta_media_type.sql — backfill must produce MIMEs
// that mimeToBucket() recognises, otherwise historical attachments end up
// in 'other' even though their extension is well-known.

const EXT_TO_MIME = {
    // images
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic',
    heif: 'image/heif', avif: 'image/avif', ico: 'image/x-icon',
    // video
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
    // audio
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac',
    flac: 'audio/flac', wma: 'audio/x-ms-wma',
    // documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
    // archives
    zip: 'application/zip', rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
    gz: 'application/gzip'
};

function urlToMime(url) {
    if (!url || typeof url !== 'string') return null;
    // Strip query string (Discord CDN URLs have ?ex=…&is=…) and fragment.
    const pathOnly = url.split('?')[0].split('#')[0];
    const m = pathOnly.match(/\.([a-zA-Z0-9]+)$/);
    if (!m) return null;
    return EXT_TO_MIME[m[1].toLowerCase()] || null;
}

// Display-bucket mapping. Six buckets keep the email block compact; raw
// MIME is preserved in the column for any future, finer-grained reports.
//
// Strips RFC-1521 parameters before matching: Discord and some webhook
// callers send 'application/pdf; charset=binary' or similar — without
// the split, those would silently fall through to 'other' even though
// the base type is well-known.
function mimeToBucket(mime) {
    if (!mime || typeof mime !== 'string') return 'other';
    const m = mime.toLowerCase().split(';')[0].trim();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (m === 'application/pdf') return 'document';
    if (m.startsWith('application/msword')) return 'document';
    if (m.startsWith('application/vnd.openxmlformats')) return 'document';
    if (m.startsWith('application/vnd.ms-')) return 'document';
    if (m.startsWith('application/vnd.oasis.opendocument')) return 'document';
    if (m === 'application/rtf') return 'document';
    if (m.startsWith('text/')) return 'document';
    if (m === 'application/zip') return 'archive';
    if (m === 'application/vnd.rar') return 'archive';
    if (m === 'application/x-7z-compressed') return 'archive';
    if (m === 'application/x-tar') return 'archive';
    if (m === 'application/gzip') return 'archive';
    return 'other';
}

module.exports = {
    urlToMime,
    mimeToBucket,
    EXT_TO_MIME
};

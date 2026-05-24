/**
 * lib/attachment-packet.js
 *
 * Single source of truth for MIME tables, buffer resolution, and list
 * normalisation across all ingest channels (Twilio, LINE, Telegram,
 * agent-pipe base64) and the Nyan-AI media layer.
 *
 * Design principle: "a packet is a packet regardless of origin."
 *   resolveBuffer() normalises every ingest path to { buffer, mimeType, filename }
 *   so callers (downloadMedia implementations, agent-pipe queue handler)
 *   never repeat MIME-lookup or filename-derivation logic.
 *
 * MIME tables:
 *   MIME_FROM_EXT  — extension (lower-case) → canonical MIME string
 *   MIME_TO_EXT    — MIME string → preferred extension (reverse of above)
 *
 * Buffer resolution:
 *   resolveBuffer({ mediaUrl?, axiosOpts?, base64?, mimeType?, filename?, prefixName? })
 *     → Promise<{ buffer, mimeType, filename } | null>
 *
 * List normalisation (re-exported for backward-compat; previously in routes/nyan-ai/media.js):
 *   normalizePhotoList, normalizeDocList, extractZipAttachments, collectAudioList
 *
 * MIME derive helpers (re-exported for backward-compat; previously in lib/agent-pipe-schema.js):
 *   deriveMimeFromDoc, deriveMimeFromPhoto
 */

'use strict';

const axios = require('axios');
const { withRetry } = require('./fetch-retry');

// ── MIME ↔ extension tables ──────────────────────────────────────────────────

const MIME_FROM_EXT = {
    pdf:  'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt:  'application/vnd.ms-powerpoint',
    csv:  'text/csv',
    txt:  'text/plain',
    json: 'application/json',
    xml:  'application/xml',
    zip:  'application/zip',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    mp4:  'video/mp4',
    mov:  'video/quicktime',
    mp3:  'audio/mpeg',
    ogg:  'audio/ogg',
    wav:  'audio/wav',
    m4a:  'audio/m4a',
    opus: 'audio/opus',
    webm: 'audio/webm',
};

// Reverse map — MIME → preferred extension.
// Build from MIME_FROM_EXT so the two tables never drift apart.
// When multiple extensions share a MIME the last writer wins;
// explicit aliases below enforce the preferred form.
const MIME_TO_EXT = {};
for (const [ext, mime] of Object.entries(MIME_FROM_EXT)) {
    MIME_TO_EXT[mime] = ext;
}
// Preferred aliases (override last-writer-wins defaults)
MIME_TO_EXT['image/jpeg']            = 'jpg';   // jpeg → jpg
MIME_TO_EXT['audio/webm']            = 'webm';  // keep webm for audio/webm
MIME_TO_EXT['application/octet-stream'] = 'bin'; // generic binary → .bin

// ── Internal helpers ─────────────────────────────────────────────────────────

function _extFromMime(mime) {
    if (!mime) return null;
    const base = mime.split(';')[0].trim().toLowerCase();
    if (MIME_TO_EXT[base]) return MIME_TO_EXT[base];
    // Generic fallback: second segment of MIME (e.g. 'jpeg' from 'image/jpeg')
    const sub = base.split('/')[1];
    return sub || null;
}

function _extFromUrl(url) {
    if (!url) return null;
    try {
        const pathname = new URL(url).pathname;
        const dot = pathname.lastIndexOf('.');
        if (dot !== -1) return pathname.slice(dot + 1).split('?')[0].toLowerCase() || null;
    } catch {
        // malformed URL — ignore
    }
    return null;
}

// ── Buffer resolution ────────────────────────────────────────────────────────

/**
 * Normalise any ingest source into { buffer, mimeType, filename }.
 *
 * Two mutually-exclusive source shapes:
 *   1. base64   — raw base64 string (agent-pipe photos[]/documents[])
 *                 Accepts optional data-URI prefix (data:<mime>;base64,<data>).
 *   2. mediaUrl — remote URL to fetch (Twilio, LINE content API, Telegram CDN)
 *
 * Priority for mimeType resolution:
 *   explicit mimeType arg → data-URI prefix → response Content-Type header → 'application/octet-stream'
 *
 * Priority for filename resolution:
 *   explicit filename arg → derived from mimeType → derived from URL path → '<prefixName>_<ts>.bin'
 *
 * @param {object} opts
 * @param {string}  [opts.mediaUrl]    Remote URL to fetch
 * @param {object}  [opts.axiosOpts]   Extra axios options (e.g. auth headers)
 * @param {string}  [opts.base64]      Base64-encoded file data
 * @param {string}  [opts.mimeType]    Caller-supplied MIME (highest priority)
 * @param {string}  [opts.filename]    Caller-supplied filename (bypasses derivation)
 * @param {string}  [opts.prefixName]  Prefix for auto-derived filename (default 'media')
 * @returns {Promise<{buffer: Buffer, mimeType: string, filename: string}|null>}
 */
async function resolveBuffer({ mediaUrl, axiosOpts = {}, base64, mimeType, filename, prefixName = 'media' }) {
    let buffer;
    let resolvedMime = mimeType || null;

    if (base64) {
        // Strip optional data-URI prefix (data:<mime>;base64,<data>)
        let raw = base64;
        const dataUriMatch = base64.match(/^data:([^;]+);base64,(.+)$/s);
        if (dataUriMatch) {
            if (!resolvedMime) resolvedMime = dataUriMatch[1];
            raw = dataUriMatch[2];
        }
        buffer = Buffer.from(raw, 'base64');
    } else if (mediaUrl) {
        const response = await withRetry(
            () => axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000, ...axiosOpts }),
            { label: 'resolveBuffer', maxAttempts: 3 }
        );
        buffer = Buffer.from(response.data);
        if (!resolvedMime) {
            resolvedMime = response.headers['content-type'] || null;
        }
    } else {
        return null;
    }

    resolvedMime = resolvedMime || 'application/octet-stream';

    // Derive filename if not supplied
    if (!filename) {
        const ext = _extFromMime(resolvedMime)
                 || _extFromUrl(mediaUrl)
                 || 'bin';
        filename = `${prefixName}_${Date.now()}.${ext}`;
    }

    return { buffer, mimeType: resolvedMime, filename };
}

// ── MIME derive helpers (used by agent-pipe schema and routes/pipe.js) ───────

/**
 * Derive the MIME type for a document entry.
 * Priority: explicit `type` token → filename extension → null.
 *
 * @param {{ name?: string, type?: string }} doc
 * @returns {string|null}
 */
function deriveMimeFromDoc(doc) {
    if (!doc) return null;
    const typeToken = (doc.type || '').toLowerCase().trim();
    if (typeToken && MIME_FROM_EXT[typeToken]) return MIME_FROM_EXT[typeToken];
    if (typeToken && typeToken.includes('/')) return typeToken;  // already a full MIME
    const ext = (doc.name || '').split('.').pop().toLowerCase();
    return MIME_FROM_EXT[ext] || null;
}

/**
 * Derive the MIME type for a photo entry.
 * Priority: explicit `type` token → filename extension → 'image/jpeg'.
 *
 * @param {{ name?: string, type?: string }|string} photo
 * @returns {string}
 */
function deriveMimeFromPhoto(photo) {
    if (typeof photo === 'string') return 'image/jpeg';
    const typeToken = (photo.type || '').toLowerCase().trim();
    if (typeToken && MIME_FROM_EXT[typeToken]) return MIME_FROM_EXT[typeToken];
    const ext = (photo.name || '').split('.').pop().toLowerCase();
    return MIME_FROM_EXT[ext] || 'image/jpeg';
}

// ── List normalisation helpers ───────────────────────────────────────────────
// Canonical definitions live here; routes/nyan-ai/media.js re-exports them
// for backward compatibility with existing callers.

function normalizePhotoList(photos, photo) {
    const photoList = [];
    if (photos && Array.isArray(photos)) {
        photos.forEach((p, idx) => {
            if (typeof p === 'string') {
                photoList.push({ name: `photo-${idx}`, data: p, type: 'photo' });
            } else if (p && p.data) {
                photoList.push(p);
            }
        });
    }
    if (photo) {
        photoList.push({ name: 'image', data: photo, type: 'image' });
    }
    return photoList;
}

function normalizeDocList(documents, document, documentName) {
    const docList = [];
    if (documents && documents.length > 0) {
        docList.push(...documents.map(d => ({ name: d.name, data: d.data, type: d.type })));
    }
    if (document) {
        docList.push({ name: documentName || 'document', data: document, type: 'document' });
    }
    return docList;
}

async function extractZipAttachments(zipData) {
    const extracted = { photos: [], audios: [], documents: [] };
    if (!zipData) return extracted;
    try {
        const JSZip = require('jszip');
        const zipBuffer = Buffer.from(zipData, 'base64');
        const zip = await JSZip.loadAsync(zipBuffer);
        const manifestFile = zip.file('manifest.json');
        if (manifestFile) {
            const manifestContent = await manifestFile.async('string');
            const manifest = JSON.parse(manifestContent);
            for (const entry of manifest) {
                const file = zip.file(entry.filename || entry.path);
                if (file) {
                    const data = await file.async('base64');
                    const itemName = entry.originalName || entry.name || 'file';
                    const itemCat  = entry.type || entry.category || '';
                    const item = { name: itemName, data, type: itemCat };
                    if (itemCat === 'photo') extracted.photos.push(item);
                    else if (itemCat === 'audio') extracted.audios.push(item);
                    else if (itemCat === 'document') extracted.documents.push(item);
                }
            }
        }
    } catch (zipError) {
        const logger = require('./logger');
        logger.error({ err: zipError }, '❌ ZIP extraction error');
    }
    return extracted;
}

function collectAudioList(audios, audio) {
    const audioList = [];
    if (audios && Array.isArray(audios)) audioList.push(...audios);
    if (audio) audioList.push({ name: 'voice-recording', data: audio, type: 'audio' });
    return audioList;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    MIME_FROM_EXT,
    MIME_TO_EXT,
    resolveBuffer,
    deriveMimeFromDoc,
    deriveMimeFromPhoto,
    normalizePhotoList,
    normalizeDocList,
    extractZipAttachments,
    collectAudioList,
};

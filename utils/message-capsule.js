const crypto = require('crypto');
const fractalId = require('./fractal-id');

// SECURITY: vegapunk.js fails-closed at startup if FRACTAL_SALT is missing.
// Fallback is ephemeral random — no known string in the codebase. Dev only.
const FRACTAL_SALT = process.env.FRACTAL_SALT || (() => {
    const ephemeral = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️  FRACTAL_SALT not set — ephemeral salt active (dev only).');
    return ephemeral;
})();

/**
 * Build a cryptographic provenance capsule (HMAC sender proof + SHA256 content hash).
 * Contains the actual message content — same payload as Discord, structured for
 * verifiability and selective disclosure.
 *
 * Selective disclosure semantics:
 *   disclosed: true  → body + attachment binary both pinned to IPFS (full copy)
 *   disclosed: false → only hash + reference stored (existence proven, content not revealed)
 *
 * @param {object} opts
 * @param {string} opts.bookFractalId        - Parent book's fractal ID
 * @param {number} opts.tenantId             - Tenant ID
 * @param {string} opts.phone                - Sender phone (hashed, not stored raw)
 * @param {string} opts.body                 - Message text body
 * @param {object|null} opts.media           - { buffer, contentType } or null
 * @param {string} opts.timestamp            - ISO timestamp string
 * @param {boolean} [opts.disclosedAttachments=true] - Whether attachment binaries are disclosed.
 *   true  → binary pinned to IPFS in full (default; inpipe messages are fully disclosed).
 *   false → hash-only reference; binary not pinned (use for privacy-sensitive re-attestations).
 * @returns {object} capsule
 */
function buildCapsule({ bookFractalId, tenantId, phone, body, media, timestamp, disclosedAttachments = true }) {
    const ts = timestamp || new Date().toISOString();
    const bodyText = body || '';

    const senderHash = crypto.createHmac('sha256', FRACTAL_SALT)
        .update(phone || '')
        .digest('hex');

    const contentHash = crypto.createHash('sha256')
        .update(bodyText)
        .digest('hex');

    const messageFractalId = fractalId.generateMsg(bookFractalId, tenantId, ts, contentHash);

    const attachments = [];
    if (media?.buffer) {
        const attachHash = crypto.createHash('sha256')
            .update(media.buffer)
            .digest('hex');
        attachments.push({
            mime: media.contentType || 'application/octet-stream',
            size_bytes: media.buffer.length,
            hash: attachHash,
            discord_url: null,
            attachment_cid: null,
            disclosed: disclosedAttachments
        });
    }

    return {
        v: 1,
        message_fractal_id: messageFractalId,
        book_fractal_id: bookFractalId,
        sender_hash: senderHash,
        timestamp: ts,
        body: bodyText,
        content_hash: contentHash,
        content_length: bodyText.length,
        attachments
    };
}

module.exports = { buildCapsule };

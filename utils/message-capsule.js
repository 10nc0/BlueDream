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
 *
 * The capsule is a lightweight proof envelope — it contains hashes and references,
 * not the full content. The actual message body lives in PostgreSQL and Discord.
 * IPFS stores only the cryptographic proof (hashes + CDN references) so Pinata
 * usage stays minimal.
 *
 * @param {object} opts
 * @param {string} opts.bookFractalId        - Parent book's fractal ID
 * @param {number} opts.tenantId             - Tenant ID
 * @param {string} opts.phone                - Sender phone (hashed, not stored raw)
 * @param {string} opts.body                 - Message text body
 * @param {object|null} opts.media           - { buffer, contentType } or null
 * @param {string} opts.timestamp            - ISO timestamp string
 * @returns {object} capsule
 */
function buildCapsule({ bookFractalId, tenantId, phone, body, media, timestamp }) {
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
            discord_url: null
        });
    }

    return {
        v: 2,
        message_fractal_id: messageFractalId,
        book_fractal_id: bookFractalId,
        sender_hash: senderHash,
        timestamp: ts,
        content_hash: contentHash,
        content_length: bodyText.length,
        attachments
    };
}

module.exports = { buildCapsule };

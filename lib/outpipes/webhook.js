'use strict';

const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { BaseOutpipe } = require('./base');
const { fetchMediaBytes } = require('./fetch-bytes');
const logger = require('../logger');

class WebhookOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.url) throw new Error('WebhookOutpipe: url required');
    }

    async deliver(capsule, options = {}) {
        // Build the metadata envelope (always sent, regardless of byte mode).
        const metadataObj = {
            sender:     capsule.sender,
            text:       capsule.text || '',
            media_url:  capsule.media_url || null,
            book_name:  capsule.book_name || null,
            timestamp:  capsule.timestamp || new Date().toISOString(),
            source:     'nyanbook'
        };
        const metadataJson = JSON.stringify(metadataObj);

        // Resolve bytes: prefer options.mediaBuffer (fast-path, fetched once by
        // router before the outpipe loop) then fall back to a fresh GET so the
        // outbox retry path can also forward bytes.
        let buffer      = options.mediaBuffer      || null;
        let contentType = options.mediaContentType || 'application/octet-stream';

        if (!buffer && capsule.media_url) {
            const fetched = await fetchMediaBytes(capsule.media_url);
            if (fetched) {
                buffer      = fetched.buffer;
                contentType = fetched.contentType;
            }
        }

        const baseHeaders = {
            'X-Nyanbook-Timestamp': metadataObj.timestamp
        };
        if (capsule.id) baseHeaders['X-Nyanbook-Event-Id'] = capsule.id;

        if (buffer) {
            // ── Byte-forward path: multipart/form-data ────────────────────────
            // Two parts:
            //   file     — raw bytes, correct Content-Type, filename from URL
            //   metadata — JSON envelope (all fields above)
            // Signature covers the metadata JSON so receivers can verify content
            // without having to re-parse the binary.
            const filename = capsule.media_url
                ? (capsule.media_url.split('/').pop()?.split('?')[0] || 'attachment')
                : 'attachment';

            const form = new FormData();
            form.append('file', buffer, { filename, contentType });
            form.append('metadata', metadataJson, { contentType: 'application/json' });

            if (this.config.secret) {
                const sig = crypto.createHmac('sha256', this.config.secret).update(metadataJson).digest('hex');
                baseHeaders['X-Nyanbook-Signature'] = `sha256=${sig}`;
            }

            await axios.post(this.config.url, form, {
                headers: { ...baseHeaders, ...form.getHeaders() },
                timeout: 30_000
            });

            logger.info({
                mode:      'byte-forward',
                byteLength: buffer.length,
                endpoint:  this.displayName
            }, `  ✅ Outpipe [webhook] → "${this.displayName}"`);

        } else {
            // ── URL-pointer fallback: plain JSON ──────────────────────────────
            // Used when: no media, byte fetch failed (source/unresolved 403,
            // network error, HTML body guard), or text-only message.
            if (this.config.secret) {
                const sig = crypto.createHmac('sha256', this.config.secret).update(metadataJson).digest('hex');
                baseHeaders['X-Nyanbook-Signature'] = `sha256=${sig}`;
            }

            await axios.post(this.config.url, metadataJson, {
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                timeout: 5_000
            });

            logger.info({
                mode:     'url-pointer',
                hasMedia: !!capsule.media_url,
                endpoint: this.displayName
            }, `  ✅ Outpipe [webhook] → "${this.displayName}"`);
        }
    }

    static validateConfig(config) {
        const base = super.validateConfig(config);
        if (!base.valid) return base;
        if (!config.url) return { valid: false, error: 'url required for webhook outpipe' };
        try { new URL(config.url); } catch { return { valid: false, error: 'invalid url' }; }
        return { valid: true };
    }
}

module.exports = { WebhookOutpipe };

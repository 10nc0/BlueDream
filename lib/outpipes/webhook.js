'use strict';

const crypto   = require('crypto');
const axios    = require('axios');
const FormData = require('form-data');
const { BaseOutpipe, resolveMedia, postToDiscord } = require('./base');
const logger = require('../logger');

// Matches discord.com, discordapp.com (legacy), canary.discord.com, ptb.discord.com.
// Test is idempotent — pure regex, no side effects.
const DISCORD_WEBHOOK_RE = /discord(?:app)?\.com\/api\/webhooks\//i;

class WebhookOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.url) throw new Error('WebhookOutpipe: url required');
    }

    async deliver(capsule, options = {}) {
        const media = await resolveMedia(capsule, options);

        // Discord webhook URLs speak Discord's grammar — route through the shared
        // Discord delivery function so type:'webhook' books pointing at Discord
        // get proper username/content/files[0] formatting without needing reconfiguration.
        // Covers both discord.com and legacy discordapp.com URLs.
        if (DISCORD_WEBHOOK_RE.test(this.config.url)) {
            await postToDiscord(this.config.url, capsule, media);
            logger.info({ endpoint: this.displayName },
                `  ✅ Outpipe [webhook→discord] → "${this.displayName}"`);
            return;
        }

        // Generic HMAC envelope — one packet shape for all payloads.
        // Transport branches only on bytes availability (multipart vs JSON);
        // the grammar (sender/text/media_url/...) is identical either way.
        const meta = {
            sender:    capsule.sender,
            text:      capsule.text      || '',
            media_url: capsule.media_url || null,
            book_name: capsule.book_name || null,
            timestamp: capsule.timestamp || new Date().toISOString(),
            source:    'nyanbook'
        };
        const metaJson = JSON.stringify(meta);
        const headers  = { 'X-Nyanbook-Timestamp': meta.timestamp };
        if (capsule.id)       headers['X-Nyanbook-Event-Id']   = capsule.id;
        if (this.config.secret) {
            headers['X-Nyanbook-Signature'] =
                `sha256=${crypto.createHmac('sha256', this.config.secret).update(metaJson).digest('hex')}`;
        }

        if (media?.buffer) {
            const filename = capsule.media_url?.split('/').pop()?.split('?')[0] || 'attachment';
            const form = new FormData();
            form.append('file', media.buffer, { filename, contentType: media.contentType });
            form.append('metadata', metaJson, { contentType: 'application/json' });
            await axios.post(this.config.url, form, {
                headers: { ...headers, ...form.getHeaders() },
                timeout: 15_000
            });
        } else {
            await axios.post(this.config.url, metaJson, {
                headers: { ...headers, 'Content-Type': 'application/json' },
                timeout: 5_000
            });
        }

        logger.info({ endpoint: this.displayName, hasMedia: !!media?.buffer },
            `  ✅ Outpipe [webhook] → "${this.displayName}"`);
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

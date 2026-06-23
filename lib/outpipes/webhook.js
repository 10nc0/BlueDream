'use strict';

const crypto   = require('crypto');
const axios    = require('axios');
const FormData = require('form-data');
const { BaseOutpipe, resolveMedia, postToDiscord } = require('./base');
const logger = require('../logger');

// ── Webhook = the HTTP-POST transport category (the genus) ────────────────────
//
// A webhook is the higher category: "POST a payload to a URL." What varies is
// the GRAMMAR — the shape of the payload on the wire:
//
//   • discord  → Discord's grammar  (username / content / embeds / files[0])
//   • generic  → NyanBook's own HMAC-signed envelope (sender/text/media_url/…)
//
// Discord is therefore an *application* of webhook, not a sibling of it.
// DiscordOutpipe (discord.js) extends this class and pins grammar='discord'.
//
// Future HTTP destinations (Slack, Teams, …) are further applications of this
// same transport — add a grammar branch here, not a new transport class.
//
// Email / SMS are NOT webhooks: they ride different transports (Resend API,
// Twilio API) and so extend BaseOutpipe directly. The dividing line is the
// transport, not the destination brand.

// Matches discord.com, discordapp.com (legacy), canary./ptb. subdomains.
// Test is idempotent — pure regex, no side effects.
const DISCORD_WEBHOOK_RE = /discord(?:app)?\.com\/api\/webhooks\//i;

class WebhookOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.url) throw new Error('WebhookOutpipe: url required');
    }

    // Resolve which grammar this webhook speaks.
    // Explicit config.grammar wins (set by subclasses like DiscordOutpipe);
    // otherwise sniff the URL for Discord and fall back to the generic envelope.
    resolveGrammar() {
        if (this.config.grammar) return this.config.grammar;
        if (DISCORD_WEBHOOK_RE.test(this.config.url)) return 'discord';
        return 'generic';
    }

    async deliver(capsule, options = {}) {
        const media   = await resolveMedia(capsule, options);
        const grammar = this.resolveGrammar();

        if (grammar === 'discord') {
            // Discord grammar — chunking, sender label and media handled inside
            // the shared postToDiscord serializer.
            await postToDiscord(this.config.url, capsule, media);
            logger.info({ endpoint: this.displayName, grammar },
                `  ✅ Outpipe [webhook·discord] → "${this.displayName}"`);
            return;
        }

        await this._deliverGeneric(capsule, media);
        logger.info({ endpoint: this.displayName, grammar, hasMedia: !!media?.buffer },
            `  ✅ Outpipe [webhook·generic] → "${this.displayName}"`);
    }

    // Generic HMAC envelope — one packet shape for all payloads.
    // Transport branches only on bytes availability (multipart vs JSON);
    // the grammar (sender/text/media_url/…) is identical either way.
    async _deliverGeneric(capsule, media) {
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
        if (capsule.id)         headers['X-Nyanbook-Event-Id'] = capsule.id;
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

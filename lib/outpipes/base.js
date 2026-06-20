'use strict';

const axios     = require('axios');
const FormData  = require('form-data');
const { fetchMediaBytes } = require('./fetch-bytes');

// ── Shared helpers (mycelium root) ────────────────────────────────────────────
//
// buildSenderLabel — canonical label for all Discord-bound sender fields.
//                    phone (fact) + [senderName] (claim) on one line when both
//                    are available and differ. Deduplicates when name === phone.
//                    Single definition — any format change lives here only.
//                    Used by: postToDiscord (outpipe), packet-queue discordPayload (ledger).
//
// resolveMedia   — resolves bytes once regardless of source (fast-path buffer
//                  from router, or fresh fetch from capsule.media_url).
//                  Returns { buffer, contentType } or null.
//
// postToDiscord  — single function for all Discord webhook delivery.
//                  Text and media are the same packet; transport branches only
//                  on whether bytes are available (multipart vs JSON).
//                  Callers pass the result of resolveMedia directly.

function buildSenderLabel(sender, senderName) {
    if (senderName && senderName !== sender) return `${sender} [${senderName}]`;
    return sender || 'NyanBook';
}

async function resolveMedia(capsule, options = {}) {
    if (options.mediaBuffer) {
        return { buffer: options.mediaBuffer, contentType: options.mediaContentType || 'application/octet-stream' };
    }
    if (capsule.media_url) {
        const fetched = await fetchMediaBytes(capsule.media_url);
        if (fetched) return { buffer: fetched.buffer, contentType: fetched.contentType };
    }
    return null;
}

async function postToDiscord(url, capsule, media) {
    const payload = {
        username:   buildSenderLabel(capsule.sender, capsule.senderName),
        avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
        content:    capsule.text     || '',
        embeds:     []
    };
    // Embed CDN image when we have a URL but no uploadable bytes — Discord renders it inline.
    if (capsule.media_url && !media?.buffer) {
        payload.embeds.push({ image: { url: capsule.media_url } });
    }

    const dest = new URL(url);
    dest.searchParams.set('wait', 'true');

    if (media?.buffer) {
        const filename = capsule.media_url?.split('/').pop()?.split('?')[0] || 'attachment';
        const form = new FormData();
        form.append('files[0]', media.buffer, { filename, contentType: media.contentType });
        form.append('payload_json', JSON.stringify(payload));
        return axios.post(dest.toString(), form, { headers: form.getHeaders(), timeout: 15_000 });
    }
    return axios.post(dest.toString(), payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5_000
    });
}

// ── Base class ────────────────────────────────────────────────────────────────

class BaseOutpipe {
    constructor(config) {
        this.config      = config;
        this.type        = config.type;
        this.displayName = config.name || config.type;
    }

    async deliver(capsule, options = {}) {
        throw new Error(`${this.type}: deliver() not implemented`);
    }

    static validateConfig(config) {
        if (!config || !config.type) return { valid: false, error: 'type required' };
        return { valid: true };
    }
}

module.exports = { BaseOutpipe, resolveMedia, postToDiscord, buildSenderLabel };

'use strict';

const axios     = require('axios');
const FormData  = require('form-data');
const { fetchMediaBytes } = require('./fetch-bytes');
const { splitMessageIntoChunks } = require('../discord-webhooks');

// Discord hard limit for webhook `content` field.
// Embed description has a higher limit (4 096) — this constant is for content only.
const DISCORD_CONTENT_LIMIT = 2000;

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
    // Chunk at the content limit so callers never need to think about it.
    // Media + CDN embed are attached to the first chunk only; subsequent chunks
    // are plain text so Discord does not reject them for combined size.
    const chunks = splitMessageIntoChunks(capsule.text || '', DISCORD_CONTENT_LIMIT);
    const dest   = new URL(url);
    dest.searchParams.set('wait', 'true');

    let lastResponse;
    for (let i = 0; i < chunks.length; i++) {
        const chunkMedia = i === 0 ? media : null;
        const payload = {
            username:   buildSenderLabel(capsule.sender, capsule.senderName),
            avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
            content:    chunks[i],
            embeds:     []
        };
        // Embed CDN image on first chunk only — Discord renders it inline.
        if (i === 0 && capsule.media_url && !chunkMedia?.buffer) {
            payload.embeds.push({ image: { url: capsule.media_url } });
        }

        if (chunkMedia?.buffer) {
            const filename = capsule.media_url?.split('/').pop()?.split('?')[0] || 'attachment';
            const form = new FormData();
            form.append('files[0]', chunkMedia.buffer, { filename, contentType: chunkMedia.contentType });
            form.append('payload_json', JSON.stringify(payload));
            lastResponse = await axios.post(dest.toString(), form, { headers: form.getHeaders(), timeout: 15_000 });
        } else {
            lastResponse = await axios.post(dest.toString(), payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5_000
            });
        }
    }
    return lastResponse;
}

// ── Base class ────────────────────────────────────────────────────────────────
//
// Outpipe taxonomy — two orthogonal axes, kept deliberately separate:
//
//   TRANSPORT (how bytes physically move) — defines the class hierarchy:
//     • WebhookOutpipe  → HTTP POST to a URL          (webhook.js)
//     • EmailOutpipe    → Resend API + MIME           (email.js)
//     • (future) Sms    → Twilio API                  — would extend BaseOutpipe
//
//   GRAMMAR (how the payload is shaped) — varies WITHIN a transport:
//     • on webhook: 'discord' (username/content/embeds/files[]) | 'generic' (HMAC envelope)
//     • on email:   MIME (subject/html/attachments)
//
// Discord is an *application* of the webhook transport (a grammar), so
// DiscordOutpipe extends WebhookOutpipe — it is NOT a sibling transport.
// Email/SMS are genuinely different transports, so they extend BaseOutpipe.
// When adding a destination, first ask: same transport, new grammar? → extend
// the transport class. New transport? → extend BaseOutpipe.

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

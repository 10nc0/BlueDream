'use strict';

const { WebhookOutpipe } = require('./webhook');

// ── Discord = an application (grammar) of the webhook transport ───────────────
//
// Discord is NOT a separate transport. A Discord webhook is just an HTTP POST
// to a URL whose payload speaks Discord's grammar (username / content / embeds
// / files[0]). So DiscordOutpipe IS-A WebhookOutpipe: it inherits the transport,
// the outbox/worker plumbing, chunking (via postToDiscord) and media handling,
// and only declares which grammar it speaks.
//
// Pinning grammar='discord' (rather than relying on URL sniffing) makes the
// user-facing type:'discord' explicit and self-documenting — the user declared
// "this is Discord," so the transport does not need to sniff the URL.
//
// To add another HTTP destination with its own grammar (e.g. Slack), follow
// this same shape: extend WebhookOutpipe, pin grammar, add the branch in
// WebhookOutpipe.deliver. Do NOT add a new transport class for HTTP targets.

class DiscordOutpipe extends WebhookOutpipe {
    constructor(config) {
        super({ ...config, grammar: 'discord' });
    }

    // validateConfig is inherited from WebhookOutpipe (requires a valid url) —
    // Discord webhooks are URLs, so the transport's contract already fits.
}

module.exports = { DiscordOutpipe };

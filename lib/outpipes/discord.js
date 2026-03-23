'use strict';

const { BaseOutpipe } = require('./base');
const { postPayloadToWebhook } = require('../discord-webhooks');
const logger = require('../logger');

class DiscordOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.url) throw new Error('DiscordOutpipe: url required');
    }

    async deliver(capsule, options = {}) {
        const payload = {
            username: capsule.sender || 'NyanBook',
            avatar_url: capsule.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
            content: capsule.text || '',
            embeds: []
        };

        if (capsule.media_url) {
            payload.embeds.push({ image: { url: capsule.media_url } });
        }

        const url = new URL(this.config.url);
        url.searchParams.set('wait', 'true');
        if (options.thread_id) url.searchParams.set('thread_id', options.thread_id);

        await postPayloadToWebhook(url.toString(), payload, {
            isMedia: options.isMedia,
            mediaBufferId: options.mediaBufferId,
            tenantSchema: options.tenantSchema,
            pool: options.pool
        });

        logger.info('  ✅ Outpipe [discord] → "%s"', this.displayName);
    }

    static validateConfig(config) {
        const base = super.validateConfig(config);
        if (!base.valid) return base;
        if (!config.url) return { valid: false, error: 'url required for discord outpipe' };
        try { new URL(config.url); } catch { return { valid: false, error: 'invalid url' }; }
        return { valid: true };
    }
}

module.exports = { DiscordOutpipe };

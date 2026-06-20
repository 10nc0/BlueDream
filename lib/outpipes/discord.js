'use strict';

const { BaseOutpipe, resolveMedia, postToDiscord } = require('./base');
const logger = require('../logger');

class DiscordOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.url) throw new Error('DiscordOutpipe: url required');
    }

    async deliver(capsule, options = {}) {
        const media = await resolveMedia(capsule, options);
        await postToDiscord(this.config.url, capsule, media);
        logger.info({ endpoint: this.displayName }, `  ✅ Outpipe [discord] → "${this.displayName}"`);
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

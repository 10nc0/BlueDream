'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { BaseOutpipe } = require('./base');
const logger = require('../logger');

class WebhookOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.url) throw new Error('WebhookOutpipe: url required');
    }

    async deliver(capsule, options = {}) {
        const body = JSON.stringify({
            sender: capsule.sender,
            text: capsule.text || '',
            media_url: capsule.media_url || null,
            book_name: capsule.book_name || null,
            timestamp: capsule.timestamp || new Date().toISOString(),
            source: 'nyanbook'
        });

        const headers = {
            'Content-Type': 'application/json',
            'X-Nyanbook-Timestamp': capsule.timestamp || new Date().toISOString()
        };

        if (capsule.id) {
            headers['X-Nyanbook-Event-Id'] = capsule.id;
        }

        if (this.config.secret) {
            const sig = crypto.createHmac('sha256', this.config.secret).update(body).digest('hex');
            headers['X-Nyanbook-Signature'] = `sha256=${sig}`;
        }

        await axios.post(this.config.url, body, { headers, timeout: 5000 });
        logger.info('  ✅ Outpipe [webhook] → "%s"', this.displayName);
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

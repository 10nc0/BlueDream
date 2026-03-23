'use strict';

const { BaseOutpipe } = require('./base');
const logger = require('../logger');

class EmailOutpipe extends BaseOutpipe {
    constructor(config) {
        super(config);
        if (!config.to) throw new Error('EmailOutpipe: to (email address) required');
    }

    async deliver(capsule, options = {}) {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

        const prefix = this.config.subject_prefix || '[NyanBook]';
        const preview = (capsule.text || '').substring(0, 60);
        const ellipsis = (capsule.text || '').length > 60 ? '…' : '';
        const subject = `${prefix} ${capsule.sender || 'Message'}: ${preview}${ellipsis}`;

        let html = `<p><strong>${capsule.sender || 'Anonymous'}</strong></p>`;
        if (capsule.book_name) html += `<p style="color:#888;font-size:12px">Book: ${capsule.book_name}</p>`;
        if (capsule.text) html += `<p>${capsule.text.replace(/\n/g, '<br>')}</p>`;
        if (capsule.media_url) {
            html += `<p><a href="${capsule.media_url}">📎 Attached media</a></p>`;
        } else if (options.isMedia) {
            html += `<p style="color:#888;font-size:12px">📎 Media attached — view in Discord ledger</p>`;
        }
        html += `<hr><p style="color:#aaa;font-size:11px">Delivered by NyanBook~</p>`;

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@nyanbook.app',
            to: this.config.to,
            subject,
            html
        });

        logger.info('  ✅ Outpipe [email] → "%s" <%s>', this.displayName, this.config.to);
    }

    static validateConfig(config) {
        const base = super.validateConfig(config);
        if (!base.valid) return base;
        if (!config.to || !config.to.includes('@')) {
            return { valid: false, error: 'valid email address required for email outpipe' };
        }
        return { valid: true };
    }
}

module.exports = { EmailOutpipe };

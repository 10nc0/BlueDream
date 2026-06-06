'use strict';

const { BaseOutpipe } = require('./base');
const { fetchMediaBytes } = require('./fetch-bytes');
const logger = require('../logger');
const { EMAIL } = require('../../config/constants');

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

        // Resolve bytes: prefer options.mediaBuffer (fast-path) then fresh GET
        // (outbox retry). On success the file is attached inline so the email
        // is a self-contained record independent of Discord CDN.
        let buffer      = options.mediaBuffer      || null;
        let contentType = options.mediaContentType || 'application/octet-stream';
        let filename    = null;

        if (!buffer && capsule.media_url) {
            const fetched = await fetchMediaBytes(capsule.media_url);
            if (fetched) {
                buffer      = fetched.buffer;
                contentType = fetched.contentType;
            }
        }

        if (buffer && capsule.media_url) {
            filename = capsule.media_url.split('/').pop()?.split('?')[0] || 'attachment';
        }

        const sendParams = {
            from:    `${EMAIL.FROM_NAME} <${EMAIL.FROM_ADDRESS}>`,
            to:      this.config.to,
            subject,
            html
        };

        if (buffer && filename) {
            // Byte-forward: attach the actual file so the email stands alone
            // without a Discord CDN dependency. The <a href> link above is kept
            // in the HTML body as a fallback for clients that suppress attachments.
            sendParams.attachments = [{
                filename,
                content:     buffer,
                contentType
            }];

            await resend.emails.send(sendParams);

            logger.info({
                mode:      'byte-forward',
                byteLength: buffer.length,
                endpoint:  this.displayName
            }, `  ✅ Outpipe [email] → "${this.displayName}" <${this.config.to}>`);

        } else {
            // URL-pointer fallback: no bytes available (fetch failed, no media,
            // source/unresolved 403). Email still delivers with the link.
            await resend.emails.send(sendParams);

            logger.info({
                mode:     'url-pointer',
                hasMedia: !!capsule.media_url,
                endpoint: this.displayName
            }, `  ✅ Outpipe [email] → "${this.displayName}" <${this.config.to}>`);
        }
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

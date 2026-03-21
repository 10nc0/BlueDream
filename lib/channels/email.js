const { BaseChannel } = require('./base');

class EmailChannel extends BaseChannel {
    constructor(deps = {}) {
        super('email');
        this.logger = deps.logger || console;
    }

    async initialize() {}

    isConfigured() {
        return !!process.env.EMAIL_INPIPE_SECRET;
    }

    validateSecret(req) {
        const secret = process.env.EMAIL_INPIPE_SECRET;
        if (!secret) {
            return { valid: false, error: 'Email inpipe not configured', status: 503 };
        }
        const provided = req.get('X-Inpipe-Secret') || req.query.secret;
        if (provided !== secret) {
            this.logger.warn('Email inpipe: invalid secret');
            return { valid: false, error: 'Forbidden', status: 403 };
        }
        return { valid: true };
    }

    parsePayload(req) {
        const b = req.body;

        // Support Mailgun (stripped-text / body-plain) and generic (text / body)
        const text = b['stripped-text'] || b['body-plain'] || b.text || b.body || '';
        const subject = b.Subject || b.subject || '';

        // Parse FROM — handle "Display Name <email@host>" format
        const rawFrom = b.From || b.from || '';
        const fromMatch = rawFrom.match(/<([^>]+)>/);
        const from = (fromMatch ? fromMatch[1] : rawFrom).trim().toLowerCase();

        // Parse TO — local part before @ is the book join code
        // e.g. mybookcode@nyanbook.io → "mybookcode"
        const rawTo = b.To || b.to || '';
        const toMatch = rawTo.match(/<([^>]+)>/);
        const toAddress = (toMatch ? toMatch[1] : rawTo).trim().toLowerCase();
        const toLocal = toAddress.split('@')[0] || '';

        const messageId = b['Message-Id'] || b['message-id'] || b.messageId || `email-${Date.now()}`;

        // Prepend subject so it survives into the Discord archive
        const fullBody = subject ? `[${subject}]\n${text}` : text;

        return { from, rawFrom, toAddress, toLocal, body: fullBody, messageId };
    }

    normalizeMessage(rawPayload) {
        return {
            channel: 'email',
            phone: rawPayload.from,        // sender email = channel identity
            rawFrom: rawPayload.rawFrom,
            body: rawPayload.body?.trim() || '',
            bodyLower: rawPayload.body?.toLowerCase().trim() || '',
            joinCode: rawPayload.toLocal,  // TO local part = book join code
            messageId: rawPayload.messageId,
            hasMedia: false,
            mediaUrl: null,
            mediaContentType: null,
            timestamp: new Date().toISOString()
        };
    }

    async downloadMedia() {
        return null; // Attachment support: future work
    }

    async sendReply() {
        return false; // Email auto-reply not implemented
    }

    getEmptyResponse() {
        return { status: 200, body: '', contentType: 'text/plain' };
    }

    isSandboxJoinCommand() {
        return false;
    }
}

module.exports = { EmailChannel };

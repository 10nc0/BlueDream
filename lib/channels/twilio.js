const twilio = require('twilio');
const axios = require('axios');
const { BaseChannel } = require('./base');
const { resolveBuffer } = require('../attachment-packet');

class TwilioChannel extends BaseChannel {
    constructor(deps = {}) {
        super('twilio');
        this.twilioHelper = null;
        this.logger = deps.logger || console;
    }
    
    async initialize() {
        try {
            this.twilioHelper = require('../twilio-client');
        } catch (err) {
            this.logger.warn('Twilio client not available');
        }
    }
    
    validateSignature(req) {
        const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
        if (!TWILIO_AUTH_TOKEN) {
            return { valid: false, error: 'Twilio authentication not configured', status: 503 };
        }
        
        const twilioSignature = req.get('X-Twilio-Signature');
        if (!twilioSignature) {
            return { valid: false, error: 'Missing signature', status: 401 };
        }
        
        const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'https';
        const host = req.get('X-Forwarded-Host') || req.get('Host') || req.hostname;
        const webhookUrl = process.env.TWILIO_WEBHOOK_URL || `${protocol}://${host}${req.originalUrl}`;
        const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, webhookUrl, req.body);
        
        if (!isValid) {
            this.logger.warn({ webhookUrl, host, protocol }, 'Twilio signature validation failed');
            return { valid: false, error: 'Invalid signature', status: 401 };
        }
        
        return { valid: true };
    }
    
    validateSignatureWithRawBody(req, logger) {
        const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
        if (!TWILIO_AUTH_TOKEN) {
            this.logger.error('TWILIO_AUTH_TOKEN not configured');
            return { valid: false, error: 'Twilio authentication not configured', status: 503 };
        }
        
        const twilioSignature = req.get('X-Twilio-Signature');
        if (!twilioSignature) {
            this.logger.warn('Missing X-Twilio-Signature header');
            return { valid: false, error: 'Missing signature', status: 401 };
        }
        
        const webhookUrl = process.env.TWILIO_WEBHOOK_URL;
        
        const isValid = twilio.validateExpressRequest(req, TWILIO_AUTH_TOKEN, {
            url: webhookUrl,
            protocol: 'https'
        });
        
        if (isValid) {
            this.logger.info('Twilio signature validated via validateExpressRequest');
            return { valid: true };
        }
        
        this.logger.warn({ 
            webhookUrl,
            bodyKeys: Object.keys(req.body || {}),
            originalUrl: req.originalUrl,
            host: req.get('Host')
        }, 'Twilio signature validation failed');
        
        return { valid: false, error: 'Invalid signature', status: 401 };
    }
    
    parsePayload(req) {
        const { From, Body, MessageSid, MediaUrl0, MediaContentType0, DateCreated, ProfileName } = req.body;
        return {
            from: From,
            body: Body,
            messageId: MessageSid,
            mediaUrl: MediaUrl0,
            mediaContentType: MediaContentType0,
            dateSent: DateCreated || null,
            ProfileName: ProfileName || null
        };
    }
    
    normalizeMessage(rawPayload) {
        const phone = rawPayload.from.replace('whatsapp:', '').trim();
        const bodyText = rawPayload.body?.trim() || '';
        const joinCodeMatch = bodyText.match(/([a-z0-9]+)-([a-f0-9]{6,})/i);

        // Prefer Twilio's DateCreated (authoritative send time, UTC ISO string)
        // over server wall-clock so sequence order survives burst/reorder delivery.
        // Guard: malformed DateCreated must not crash normalisation — fall back to null.
        let sentAt = null;
        if (rawPayload.dateSent) {
            const parsed = new Date(rawPayload.dateSent);
            if (!isNaN(parsed.getTime())) sentAt = parsed.toISOString();
        }

        return {
            channel: 'twilio',
            phone: phone,
            senderName: rawPayload.ProfileName || phone,
            rawFrom: rawPayload.from,
            body: bodyText,
            bodyLower: bodyText.toLowerCase(),
            joinCode: joinCodeMatch ? joinCodeMatch[0] : null,
            messageId: rawPayload.messageId,
            hasMedia: !!rawPayload.mediaUrl,
            mediaUrl: rawPayload.mediaUrl,
            mediaContentType: rawPayload.mediaContentType,
            sentAt,
            timestamp: sentAt || new Date().toISOString()
        };
    }
    
    async downloadMedia(mediaUrl, mediaContentType) {
        if (!mediaUrl) return null;
        try {
            this.logger.info({ mediaUrl: mediaUrl.substring(0, 60) }, 'Downloading media from Twilio');
            const result = await resolveBuffer({
                mediaUrl,
                mimeType: mediaContentType || null,
                prefixName: 'twilio'
            });
            if (!result) return null;
            this.logger.info({ bytes: result.buffer.length, contentType: result.mimeType }, 'Downloaded media');
            return { buffer: result.buffer, filename: result.filename, contentType: result.mimeType };
        } catch (error) {
            this.logger.error({ error: error.message, mediaUrl: mediaUrl.substring(0, 60) }, 'Failed to download media');
            return null;
        }
    }
    
    async sendReply(to, message) {
        if (!this.twilioHelper) {
            this.logger.warn('Twilio client not initialized');
            return false;
        }
        
        try {
            const client = await this.twilioHelper.getTwilioClient();
            const fromNumber = await this.twilioHelper.getTwilioFromPhoneNumber();
            
            await client.messages.create({
                from: `whatsapp:${fromNumber}`,
                to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
                body: message
            });
            
            this.logger.info({ to }, 'Sent Twilio reply');
            return true;
        } catch (error) {
            this.logger.warn({ error: error.message, to }, 'Could not send Twilio reply');
            return false;
        }
    }
    
    getEmptyResponse() {
        return {
            status: 200,
            body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
            contentType: 'text/xml'
        };
    }
    
    isSandboxJoinCommand(bodyLower) {
        const cmd = (process.env.TWILIO_JOIN_COMMAND || 'join baby-ability').toLowerCase();
        return bodyLower === cmd;
    }
}

module.exports = { TwilioChannel };

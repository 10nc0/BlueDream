const twilio = require('twilio');
const axios = require('axios');
const { BaseChannel } = require('./base');

class TwilioChannel extends BaseChannel {
    constructor(deps = {}) {
        super('twilio');
        this.twilioHelper = null;
        this.logger = deps.logger || console;
    }
    
    async initialize() {
        try {
            this.twilioHelper = require('../../twilio-client');
        } catch (err) {
            this.logger.warn('Twilio client not available');
        }
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
        const { From, Body, MessageSid, MediaUrl0, MediaContentType0 } = req.body;
        return {
            from: From,
            body: Body,
            messageId: MessageSid,
            mediaUrl: MediaUrl0,
            mediaContentType: MediaContentType0
        };
    }
    
    normalizeMessage(rawPayload) {
        const phone = rawPayload.from.replace('whatsapp:', '').trim();
        const bodyText = rawPayload.body?.trim() || '';
        const joinCodeMatch = bodyText.match(/([a-z0-9]+)-([a-f0-9]{6})/i);
        
        return {
            channel: 'twilio',
            phone: phone,
            rawFrom: rawPayload.from,
            body: bodyText,
            bodyLower: bodyText.toLowerCase(),
            joinCode: joinCodeMatch ? joinCodeMatch[0] : null,
            messageId: rawPayload.messageId,
            hasMedia: !!rawPayload.mediaUrl,
            mediaUrl: rawPayload.mediaUrl,
            mediaContentType: rawPayload.mediaContentType,
            timestamp: new Date().toISOString()
        };
    }
    
    async downloadMedia(mediaUrl, mediaContentType) {
        if (!mediaUrl) return null;
        
        try {
            this.logger.info({ mediaUrl: mediaUrl.substring(0, 60) }, 'Downloading media from Twilio');
            
            const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
            const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
            
            const authConfig = {};
            if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && mediaUrl.includes('api.twilio.com')) {
                authConfig.auth = {
                    username: TWILIO_ACCOUNT_SID,
                    password: TWILIO_AUTH_TOKEN
                };
                this.logger.info('Using Twilio Basic Auth for media download');
            }
            
            const response = await axios.get(mediaUrl, { 
                responseType: 'arraybuffer',
                timeout: 30000,
                ...authConfig
            });
            
            const buffer = Buffer.from(response.data);
            const contentType = mediaContentType || response.headers['content-type'] || 'application/octet-stream';
            
            const mimeToExt = {
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
                'application/pdf': 'pdf',
                'image/jpeg': 'jpg',
                'image/png': 'png',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'video/mp4': 'mp4',
                'video/quicktime': 'mov',
                'audio/mpeg': 'mp3',
                'audio/ogg': 'ogg',
                'audio/opus': 'opus',
                'application/zip': 'zip',
                'text/plain': 'txt'
            };
            const ext = mimeToExt[contentType] || contentType.split('/')[1]?.split(';')[0] || 'bin';
            const filename = `media_${Date.now()}.${ext}`;
            
            this.logger.info({ bytes: buffer.length, contentType }, 'Downloaded media');
            
            return { buffer, filename, contentType };
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
        return bodyLower === 'join baby-ability';
    }
}

module.exports = { TwilioChannel };

const crypto = require('crypto');
const axios = require('axios');
const { BaseChannel } = require('./base');

// ═══════════════════════════════════════════════════════════════
// LINE CHANNEL DRIVER — Listen-Only
// ═══════════════════════════════════════════════════════════════
// Vegapunk satellite philosophy: this driver is the only file
// that knows about Line. The inpipe satellite and all handlers
// above it are channel-agnostic — they receive a normalized msg
// and dispatch via item.channel.
//
// Listen-only: Line delivers → we archive → Discord writes scroll.
// No reply is sent back to the Line sender. sendReply() is a
// deliberate no-op. The outpipe is Discord, not Line.
//
// Secrets required:
//   LINE_CHANNEL_SECRET      — HMAC-SHA256 signature validation
//   LINE_CHANNEL_ACCESS_TOKEN — media download only (optional)
// ═══════════════════════════════════════════════════════════════

class LineChannel extends BaseChannel {
    constructor(deps = {}) {
        super('line');
        this.logger = deps.logger || console;
        this.channelSecret = process.env.LINE_CHANNEL_SECRET;
        this.accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    }

    async initialize() {
        if (!this.channelSecret) {
            this.logger.warn('LINE_CHANNEL_SECRET not set — Line channel disabled');
        } else {
            this.logger.info('LineChannel initialized (listen-only)');
        }
    }

    isConfigured() {
        return !!this.channelSecret;
    }

    validateSignature(req) {
        if (!this.channelSecret) {
            return { valid: false, error: 'LINE_CHANNEL_SECRET not configured', status: 503 };
        }

        const signature = req.get('X-Line-Signature');
        if (!signature) {
            return { valid: false, error: 'Missing X-Line-Signature header', status: 401 };
        }

        const rawBody = req.rawBody;
        if (!rawBody) {
            this.logger.error('req.rawBody unavailable — bodyParser verify callback must be set in kernel');
            return { valid: false, error: 'Raw body unavailable', status: 500 };
        }

        const expected = crypto
            .createHmac('sha256', this.channelSecret)
            .update(rawBody)
            .digest('base64');

        if (expected !== signature) {
            this.logger.warn('Line signature mismatch');
            return { valid: false, error: 'Invalid signature', status: 401 };
        }

        return { valid: true };
    }

    parsePayload(req) {
        const events = req.body?.events || [];
        const event = events.find(e => e.type === 'message') || null;
        if (!event) return null;

        const msg = event.message || {};
        const isMedia = ['image', 'video', 'audio', 'file'].includes(msg.type);

        const mediaContentType = msg.type === 'image' ? 'image/jpeg'
            : msg.type === 'video' ? 'video/mp4'
            : msg.type === 'audio' ? 'audio/m4a'
            : null;

        return {
            userId: event.source?.userId || event.source?.groupId || 'unknown',
            body: msg.type === 'text' ? (msg.text || '') : null,
            messageId: msg.id,
            messageType: msg.type,
            replyToken: event.replyToken,
            timestamp: event.timestamp,
            hasMedia: isMedia,
            mediaMessageId: isMedia ? msg.id : null,
            mediaContentType
        };
    }

    normalizeMessage(rawPayload) {
        if (!rawPayload) return null;

        const bodyText = (rawPayload.body || '').trim();
        const joinCodeMatch = bodyText.match(/([a-z0-9]+)-([a-f0-9]{6})/i);

        return {
            channel: 'line',
            phone: rawPayload.userId,
            rawFrom: rawPayload.userId,
            body: bodyText,
            bodyLower: bodyText.toLowerCase(),
            joinCode: joinCodeMatch ? joinCodeMatch[0] : null,
            messageId: rawPayload.messageId,
            hasMedia: rawPayload.hasMedia,
            mediaUrl: rawPayload.mediaMessageId,
            mediaContentType: rawPayload.mediaContentType,
            timestamp: rawPayload.timestamp
                ? new Date(rawPayload.timestamp).toISOString()
                : new Date().toISOString()
        };
    }

    async downloadMedia(messageId, contentType) {
        if (!messageId) return null;
        if (!this.accessToken) {
            this.logger.warn({ messageId }, 'LINE_CHANNEL_ACCESS_TOKEN not set — cannot download media');
            return null;
        }

        try {
            this.logger.info({ messageId }, 'Downloading media from Line Content API');
            const response = await axios.get(
                `https://api-data.line.me/v2/bot/message/${messageId}/content`,
                {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: { Authorization: `Bearer ${this.accessToken}` }
                }
            );

            const buffer = Buffer.from(response.data);
            const resolvedContentType = contentType
                || response.headers['content-type']
                || 'application/octet-stream';

            const mimeToExt = {
                'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
                'video/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3',
                'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt'
            };
            const ext = mimeToExt[resolvedContentType]
                || resolvedContentType.split('/')[1]?.split(';')[0]
                || 'bin';
            const filename = `line_${Date.now()}.${ext}`;

            this.logger.info({ bytes: buffer.length, resolvedContentType }, 'Line media downloaded');
            return { buffer, filename, contentType: resolvedContentType };
        } catch (error) {
            this.logger.error({ error: error.message, messageId }, 'Failed to download Line media');
            return null;
        }
    }

    // Listen-only — deliberate no-op. The outpipe is Discord, not Line.
    async sendReply(to, message) {
        this.logger.debug({ to }, 'Line sendReply no-op (listen-only channel)');
        return false;
    }

    getEmptyResponse() {
        return { status: 200, body: '{}', contentType: 'application/json' };
    }

    isSandboxJoinCommand() {
        return false;
    }
}

module.exports = { LineChannel };

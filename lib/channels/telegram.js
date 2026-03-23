const crypto = require('crypto');
const axios = require('axios');
const { BaseChannel } = require('./base');
const { markdownToTelegramHtml, chunkText } = require('../../utils/telegram-format');

// ═══════════════════════════════════════════════════════════════
// TELEGRAM CHANNEL DRIVER
// ═══════════════════════════════════════════════════════════════
// Reply-capable inpipe (unlike LINE which is listen-only).
// Secrets:
//   TELEGRAM_BOT_TOKEN      — required: all API calls
//   TELEGRAM_WEBHOOK_SECRET — optional but recommended: header validation
//   TELEGRAM_BOT_USERNAME   — optional: used to build t.me deep links in UI
//
// Webhook validation: Telegram sends X-Telegram-Bot-Api-Secret-Token
// containing the exact value you passed as secret_token to setWebhook().
// If TELEGRAM_WEBHOOK_SECRET is not set, header check is skipped (dev only).
//
// Routing: msg.phone = String(userId), msg.rawFrom = chatId.
// The existing book_engaged_phones table and routeMessage() work
// unchanged — userId is stored where phone would be for other channels.
// ═══════════════════════════════════════════════════════════════

const TELEGRAM_API = 'https://api.telegram.org';

// Join code pattern: slug-hex  e.g. mybookname-a1b2c3d4
const JOIN_CODE_RE = /\b([a-z0-9]+-[a-f0-9]{6,})\b/i;

class TelegramChannel extends BaseChannel {
    constructor(deps = {}) {
        super('telegram');
        this.logger = deps.logger || console;
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || null;
        this.botUsername = process.env.TELEGRAM_BOT_USERNAME || null;
    }

    get _apiBase() {
        return `${TELEGRAM_API}/bot${this.botToken}`;
    }

    isConfigured() {
        return !!this.botToken;
    }

    async initialize() {
        if (!this.botToken) {
            this.logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram channel disabled');
            return;
        }
        try {
            const res = await axios.get(`${this._apiBase}/getMe`, { timeout: 8000 });
            if (res.data?.ok) {
                this.botUsername = res.data.result.username || this.botUsername;
                this.logger.info({ username: this.botUsername }, 'TelegramChannel initialized');
            }
        } catch (err) {
            this.logger.warn({ error: err.message }, 'TelegramChannel getMe failed — running with limited info');
        }
    }

    // Register this server's webhook URL with Telegram.
    // Called once on startup if TELEGRAM_BOT_TOKEN is set.
    async setWebhook(domain) {
        if (!this.isConfigured()) return;
        const webhookUrl = `https://${domain}/api/telegram/webhook`;
        const payload = {
            url: webhookUrl,
            allowed_updates: ['message'],
            drop_pending_updates: false
        };
        if (this.webhookSecret) {
            payload.secret_token = this.webhookSecret;
        }
        try {
            const res = await axios.post(`${this._apiBase}/setWebhook`, payload, { timeout: 10000 });
            if (res.data?.ok) {
                this.logger.info({ webhookUrl }, 'Telegram webhook registered');
            } else {
                this.logger.warn({ result: res.data }, 'Telegram setWebhook returned not-ok');
            }
        } catch (err) {
            this.logger.warn({ error: err.message }, 'Telegram setWebhook failed (non-fatal — bot will poll or retry on next restart)');
        }
    }

    validateSignature(req) {
        if (!this.isConfigured()) {
            return { valid: false, error: 'TELEGRAM_BOT_TOKEN not configured', status: 503 };
        }

        if (this.webhookSecret) {
            const token = req.get('X-Telegram-Bot-Api-Secret-Token');
            if (!token) {
                return { valid: false, error: 'Missing X-Telegram-Bot-Api-Secret-Token header', status: 401 };
            }
            // Telegram sends the secret verbatim — constant-time compare
            const expected = Buffer.from(this.webhookSecret);
            const received = Buffer.from(token);
            const match = expected.length === received.length &&
                          crypto.timingSafeEqual(expected, received);
            if (!match) {
                this.logger.warn('Telegram webhook secret mismatch');
                return { valid: false, error: 'Invalid webhook secret', status: 401 };
            }
        }

        return { valid: true };
    }

    parsePayload(req) {
        const update = req.body;
        if (!update) return null;

        const message = update.message;
        if (!message) return null; // ignore non-message updates (edited_message, etc.)

        const userId = message.from?.id;
        const chatId = message.chat?.id;
        if (!userId || !chatId) return null;

        const text = message.text || message.caption || '';

        // Pick highest-res photo; prefer document > audio > voice > video for other media
        const photo = message.photo ? message.photo[message.photo.length - 1] : null;
        const mediaItem = photo || message.document || message.audio || message.voice || message.video || null;

        const contentType = photo                    ? 'image/jpeg'
            : message.document?.mime_type            ? message.document.mime_type
            : message.audio                          ? 'audio/mpeg'
            : message.voice                          ? 'audio/ogg'
            : message.video                          ? 'video/mp4'
            : null;

        return {
            updateId:         update.update_id,
            messageId:        message.message_id,
            userId,
            chatId,
            body:             text,
            hasMedia:         !!mediaItem,
            mediaFileId:      mediaItem?.file_id || null,
            mediaFileName:    message.document?.file_name || null,
            mediaContentType: contentType,
            timestamp:        message.date
                ? new Date(message.date * 1000).toISOString()
                : new Date().toISOString()
        };
    }

    normalizeMessage(rawPayload) {
        if (!rawPayload) return null;

        const bodyText = (rawPayload.body || '').trim();

        // Extract join code from /start JOINCODE deep-link or plain text
        let joinCode = null;
        const startMatch = bodyText.match(/^\/start\s+(.+)/i);
        if (startMatch) {
            const candidate = startMatch[1].trim();
            if (JOIN_CODE_RE.test(candidate)) joinCode = JOIN_CODE_RE.exec(candidate)[0];
        } else {
            const m = JOIN_CODE_RE.exec(bodyText);
            if (m) joinCode = m[0];
        }

        return {
            channel:          'telegram',
            phone:            String(rawPayload.userId),   // used as routing key in book_engaged_phones
            rawFrom:          rawPayload.chatId,           // chatId used for sendReply
            body:             bodyText,
            bodyLower:        bodyText.toLowerCase(),
            joinCode,
            messageId:        String(rawPayload.messageId),
            hasMedia:         rawPayload.hasMedia,
            mediaUrl:         rawPayload.mediaFileId,      // downloadMedia(mediaUrl) → getFile(file_id)
            mediaFileName:    rawPayload.mediaFileName,
            mediaContentType: rawPayload.mediaContentType,
            timestamp:        rawPayload.timestamp
        };
    }

    async downloadMedia(fileId, contentType) {
        if (!fileId || !this.botToken) return null;
        try {
            // Step 1: resolve file path via getFile
            const info = await axios.get(`${this._apiBase}/getFile`, {
                params: { file_id: fileId },
                timeout: 10000
            });
            if (!info.data?.ok) return null;

            const filePath = info.data.result.file_path;
            const downloadUrl = `${TELEGRAM_API}/file/bot${this.botToken}/${filePath}`;

            // Step 2: download binary
            const file = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const buffer = Buffer.from(file.data);

            const resolvedType = contentType || file.headers['content-type'] || 'application/octet-stream';
            const ext = filePath.split('.').pop() || 'bin';
            const filename = `tg_${Date.now()}.${ext}`;

            this.logger.info({ bytes: buffer.length, resolvedType }, 'Telegram media downloaded');
            return { buffer, filename, contentType: resolvedType };
        } catch (err) {
            this.logger.error({ error: err.message, fileId }, 'Failed to download Telegram media');
            return null;
        }
    }

    // Send a reply to a Telegram chat (chatId = rawFrom).
    // Text is converted from markdown to Telegram HTML then chunked.
    async sendReply(chatId, text) {
        if (!this.isConfigured() || !chatId) return false;
        const html = markdownToTelegramHtml(text);
        const chunks = chunkText(html);
        try {
            for (const chunk of chunks) {
                await axios.post(`${this._apiBase}/sendMessage`, {
                    chat_id: chatId,
                    text:    chunk,
                    parse_mode: 'HTML'
                }, { timeout: 10000 });
            }
            return true;
        } catch (err) {
            this.logger.warn({ error: err.message, chatId }, 'Telegram sendMessage failed (non-fatal)');
            return false;
        }
    }

    getEmptyResponse() {
        return { status: 200, body: '{}', contentType: 'application/json' };
    }

    isSandboxJoinCommand() {
        return false; // Telegram has no sandbox join concept
    }
}

module.exports = { TelegramChannel };

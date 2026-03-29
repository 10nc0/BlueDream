// Bidirectional message pipe — handles both inbound channels (Twilio/LINE/Telegram/email
// webhooks, agent write POST) and the outbound agent read GET. All inbound paths enqueue
// to core.message_queue before ack; the read path reads Discord directly via Thoth.
const { TwilioChannel } = require('../lib/channels/twilio');
const { LineChannel } = require('../lib/channels/line');
const { EmailChannel } = require('../lib/channels/email');
const { TelegramChannel } = require('../lib/channels/telegram');
const { VALID_SCHEMA_PATTERN } = require('../lib/validators');
const format = require('pg-format');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const {
    MAX_QUEUE_SIZE,
    MESSAGE_QUEUE,
    getCachedDepth,
    setPool,
    totalQueueDepth,
    enqueueItem,
    recoverStaleProcessing,
    cleanupDoneMessages,
    startQueueProcessor,
    cleanupIdempotencyCache,
    sendChannelResponse,
    sleep
} = require('../lib/packet-queue');

function registerPipeRoutes(app, deps) {
    const { pool, bots, helpers, constants, logger } = deps;
    const { hermes: hermesBot, thoth: thothBot } = bots || {};
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    const LIMBO_THREAD_ID = constants?.LIMBO_THREAD_ID;
    const HERMES_TOKEN = constants?.HERMES_TOKEN || process.env.HERMES_TOKEN;
    
    if (!pool) {
        logger.warn('Inpipe routes: pool not available, skipping registration');
        return;
    }

    setPool(pool);
    recoverStaleProcessing(logger).catch(err => logger.error({ err }, 'Queue recovery startup failed'));
    
    const twilioChannel = new TwilioChannel({ logger });
    twilioChannel.initialize().catch(err => logger.error({ err }, 'TwilioChannel init failed'));

    const lineChannel = new LineChannel({ logger });
    lineChannel.initialize().catch(err => logger.error({ err }, 'LineChannel init failed'));

    const emailChannel = new EmailChannel({ logger });
    emailChannel.initialize().catch(err => logger.error({ err }, 'EmailChannel init failed'));

    const telegramChannel = new TelegramChannel({ logger });
    telegramChannel.initialize().then(() => {
        if (telegramChannel.isConfigured()) {
            const domain = process.env.REPLIT_DOMAINS?.split(',')[0];
            if (domain) {
                telegramChannel.setWebhook(domain).catch(err =>
                    logger.warn({ error: err.message }, 'Telegram setWebhook deferred (will retry on next restart)')
                );
            }
        }
    }).catch(err => logger.error({ err }, 'TelegramChannel init failed'));

    const webhookChannel = {
        downloadMedia: () => null,
        sendReply: () => Promise.resolve(),
        getEmptyResponse: () => ({ body: '' }),
        isConfigured: () => true
    };
    const channelRegistry = { twilio: twilioChannel, line: lineChannel, email: emailChannel, telegram: telegramChannel, webhook: webhookChannel };
    const queueProcessor = startQueueProcessor({ ...deps, channelRegistry });
    
    setInterval(() => cleanupIdempotencyCache(pool, logger), 60 * 1000);
    setInterval(() => cleanupDoneMessages(pool, logger), 60 * 60 * 1000);

    const registeredRoutes = ['POST /api/twilio/webhook'];
    
    app.post('/api/twilio/webhook', async (req, res) => {
        try {
            const sigResult = twilioChannel.validateSignature(req);
            if (!sigResult.valid) {
                logger.warn({ error: sigResult.error }, 'Twilio signature validation failed');
                return res.status(sigResult.status).send('Forbidden');
            }

            const rawPayload = twilioChannel.parsePayload(req);
            const messageSid = rawPayload.messageId;
            
            // IDEMPOTENCY GUARD: Atomic DB insert — survives restarts, covers Twilio's 11hr retry window.
            // INSERT ... ON CONFLICT DO NOTHING returns 0 rows if sid already exists → duplicate.
            if (messageSid) {
                const dedupeResult = await pool.query(
                    `INSERT INTO core.processed_sids (sid, processed_at)
                     VALUES ($1, NOW())
                     ON CONFLICT (sid) DO NOTHING
                     RETURNING sid`,
                    [messageSid]
                );
                if (dedupeResult.rows.length === 0) {
                    logger.info({ messageSid }, 'Duplicate message detected (DB) - already processed');
                    return sendChannelResponse(res, twilioChannel);
                }
            }
            
            const msg = twilioChannel.normalizeMessage(rawPayload);
            
            logger.info({ 
                phone: msg.phone, 
                body: msg.body?.substring(0, 50), 
                joinCode: msg.joinCode,
                queueSize: MESSAGE_QUEUE.length 
            }, 'Twilio webhook received - queuing');
            
            // Ignore sandbox join commands immediately
            if (twilioChannel.isSandboxJoinCommand(msg.bodyLower)) {
                logger.info('Ignoring Twilio sandbox join command');
                return sendChannelResponse(res, twilioChannel);
            }
            
            // QUEUE SIZE GUARD: Prevent memory exhaustion
            if (await totalQueueDepth() >= MAX_QUEUE_SIZE) {
                logger.warn({ queueSize: getCachedDepth() }, 'Queue full - rejecting message');
                return res.status(503).send('Server busy, please retry');
            }
            
            // QUEUE MESSAGE for async processing (media → priority tier)
            await enqueueItem({
                msg,
                rawPayload,
                channel: 'twilio',
                messageSid,
                queuedAt: Date.now()
            });
            
            logger.info({ 
                messageSid, 
                queueDepth: getCachedDepth()
            }, 'Message queued for processing');
            
            // IMMEDIATE ACK to Twilio (prevents timeout retries)
            return sendChannelResponse(res, twilioChannel);
            
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Twilio webhook error');
            const response = twilioChannel.getEmptyResponse();
            res.status(500).send(response.body);
        }
    });

    // ─── LINE WEBHOOK ────────────────────────────────────────────
    // Listen-only: receive → normalize → queue → Discord outpipe.
    // No reply sent back to Line sender (sendReply is no-op).
    // Skip route registration if LINE_CHANNEL_SECRET is absent.
    if (lineChannel.isConfigured()) {
        registeredRoutes.push('POST /api/line/webhook');
        app.post('/api/line/webhook', async (req, res) => {
            try {
                const sigResult = lineChannel.validateSignature(req);
                if (!sigResult.valid) {
                    logger.warn({ error: sigResult.error }, 'Line signature validation failed');
                    return res.status(sigResult.status).json({ error: sigResult.error });
                }

                const rawPayload = lineChannel.parsePayload(req);
                if (!rawPayload) {
                    logger.info('Line webhook: no message event — ACK and skip');
                    return res.status(200).json({});
                }

                const msg = lineChannel.normalizeMessage(rawPayload);
                if (!msg) {
                    return res.status(200).json({});
                }

                logger.info({
                    userId: msg.phone,
                    body: msg.body?.substring(0, 50),
                    joinCode: msg.joinCode,
                    hasMedia: msg.hasMedia,
                    queueSize: MESSAGE_QUEUE.length
                }, 'Line webhook received — queuing');

                if (await totalQueueDepth() >= MAX_QUEUE_SIZE) {
                    logger.warn({ queueSize: getCachedDepth() }, 'Queue full — rejecting Line message');
                    return res.status(503).json({ error: 'Server busy, please retry' });
                }

                await enqueueItem({
                    msg,
                    rawPayload,
                    channel: 'line',
                    messageSid: msg.messageId,
                    queuedAt: Date.now()
                });

                logger.info({
                    messageId: msg.messageId,
                    hasMedia: msg.hasMedia,
                    queueDepth: getCachedDepth()
                }, 'Line message queued');

                // Immediate 200 ACK to Line (required within 1 second)
                return res.status(200).json({});

            } catch (error) {
                logger.error({ error: error.message, stack: error.stack }, 'Line webhook error');
                return res.status(200).json({});  // Always 200 to Line to prevent retries
            }
        });
    } else {
        logger.warn('LINE_CHANNEL_SECRET not set — /api/line/webhook not registered');
    }

    // ─── EMAIL INPIPE ────────────────────────────────────────────
    // bookcode@nyanbook.io → parse local part → route to Discord book.
    // Routing is stateless: TO address always determines the book.
    // MX record + provider webhook must be configured externally.
    // Secret validation: X-Inpipe-Secret header must match EMAIL_INPIPE_SECRET.
    if (emailChannel.isConfigured()) {
        registeredRoutes.push('POST /api/email/inpipe');
        app.post('/api/email/inpipe', async (req, res) => {
            try {
                const secretResult = emailChannel.validateSecret(req);
                if (!secretResult.valid) {
                    logger.warn({ error: secretResult.error }, 'Email inpipe: auth failed');
                    return res.status(secretResult.status).json({ error: secretResult.error });
                }

                const rawPayload = emailChannel.parsePayload(req);

                if (!rawPayload.toLocal) {
                    logger.warn('Email inpipe: could not parse TO local part');
                    return res.status(200).json({});
                }

                const msg = emailChannel.normalizeMessage(rawPayload);

                if (!msg.body && !msg.hasMedia) {
                    logger.info({ from: msg.phone }, 'Email inpipe: empty message — skip');
                    return res.status(200).json({});
                }

                logger.info({
                    from: msg.phone,
                    joinCode: msg.joinCode,
                    bodyPreview: msg.body?.substring(0, 60),
                    queueSize: MESSAGE_QUEUE.length
                }, 'Email inpipe received — queuing');

                if (await totalQueueDepth() >= MAX_QUEUE_SIZE) {
                    logger.warn({ queueSize: getCachedDepth() }, 'Queue full — rejecting email message');
                    return res.status(503).json({ error: 'Server busy, please retry' });
                }

                await enqueueItem({
                    msg,
                    rawPayload,
                    channel: 'email',
                    messageSid: msg.messageId,
                    queuedAt: Date.now()
                });

                logger.info({
                    messageId: msg.messageId,
                    queueDepth: getCachedDepth()
                }, 'Email message queued');

                return res.status(200).json({});

            } catch (error) {
                logger.error({ error: error.message, stack: error.stack }, 'Email inpipe error');
                return res.status(200).json({});
            }
        });
    } else {
        logger.warn('⚠️ EMAIL_INPIPE_SECRET not set — /api/email/inpipe not registered');
    }

    // ─── TELEGRAM WEBHOOK ───────────────────────────────────────
    // Reply-capable: bot can send messages back to the user.
    // /start JOINCODE activates the book; subsequent messages are
    // routed via core.channel_identifiers (Telegram-only path).
    // WhatsApp/LINE continue using book_engaged_phones (legacy).
    // Skip route registration if TELEGRAM_BOT_TOKEN is absent.
    if (telegramChannel.isConfigured()) {
        registeredRoutes.push('POST /api/telegram/webhook');
        app.post('/api/telegram/webhook', async (req, res) => {
            try {
                const sigResult = telegramChannel.validateSignature(req);
                if (!sigResult.valid) {
                    logger.warn({ error: sigResult.error }, 'Telegram signature validation failed');
                    return res.status(sigResult.status).json({ error: sigResult.error });
                }

                const rawPayload = telegramChannel.parsePayload(req);
                if (!rawPayload) {
                    return res.status(200).json({});
                }

                const msg = telegramChannel.normalizeMessage(rawPayload);
                if (!msg) {
                    return res.status(200).json({});
                }

                logger.info({
                    userId:    msg.phone,
                    body:      msg.body?.substring(0, 50),
                    joinCode:  msg.joinCode,
                    hasMedia:  msg.hasMedia,
                    queueSize: MESSAGE_QUEUE.length
                }, 'Telegram webhook received — queuing');

                if (await totalQueueDepth() >= MAX_QUEUE_SIZE) {
                    logger.warn({ queueSize: getCachedDepth() }, 'Queue full — rejecting Telegram message');
                    return res.status(200).json({});
                }

                await enqueueItem({
                    msg,
                    rawPayload,
                    channel:    'telegram',
                    messageSid: msg.messageId,
                    queuedAt:   Date.now()
                });

                logger.info({
                    messageId:  msg.messageId,
                    hasMedia:   msg.hasMedia,
                    queueDepth: getCachedDepth()
                }, 'Telegram message queued');

                return res.status(200).json({});
            } catch (error) {
                logger.error({ error: error.message, stack: error.stack }, 'Telegram webhook error');
                return res.status(200).json({}); // Always 200 to Telegram to prevent retries
            }
        });
    } else {
        logger.warn('⚠️ TELEGRAM_BOT_TOKEN not set — /api/telegram/webhook not registered');
    }

    const webhookLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        validate: { xForwardedForHeader: false },
        handler: (req, res) => {
            logger.warn({ ip: req.ip }, 'Webhook rate limit exceeded');
            res.status(429).json({ error: 'Too many requests, please try again later.' });
        }
    });

    const webhookPayloadSchema = z.object({
        text: z.string().max(10000, 'Message too long').optional().default(''),
        username: z.string().max(100, 'Username too long').optional().default('External'),
        avatar_url: z.string().url('Invalid avatar URL').optional().nullable(),
        media_url: z.string().url('Invalid media URL').optional().nullable(),
        phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone format').optional().nullable(),
        email: z.string().email('Invalid email format').optional().nullable()
    });

    app.post('/api/webhook/:fractalId', webhookLimiter, async (req, res) => {
        try {
            const fractalIdParam = req.params.fractalId;
            const fractalIdPattern = /^bridge_[a-z][0-9a-z]_[a-zA-Z0-9]{6,32}$/;
            if (!fractalIdParam || !fractalIdPattern.test(fractalIdParam)) {
                return res.status(400).json({ error: 'Invalid book ID format' });
            }
            const payloadResult = webhookPayloadSchema.safeParse(req.body);
            if (!payloadResult.success) {
                return res.status(400).json({
                    error: 'Invalid payload',
                    details: payloadResult.error.issues.map(i => i.message)
                });
            }
            const { text, username, avatar_url, media_url, phone, email } = payloadResult.data;
            const fractalIdMod = require('../utils/fractal-id');
            const parsed = fractalIdMod.parse(fractalIdParam);
            if (!parsed || !parsed.tenantId) {
                return res.status(400).json({ error: 'Invalid book ID format' });
            }
            if (!Number.isInteger(parsed.tenantId) || parsed.tenantId <= 0 || parsed.tenantId > 999999) {
                return res.status(400).json({ error: 'Invalid tenant ID' });
            }
            const tenantSchema = `tenant_${parsed.tenantId}`;
            if (!VALID_SCHEMA_PATTERN.test(tenantSchema)) {
                return res.status(400).json({ error: 'Invalid tenant schema' });
            }

            const bookCheck = await pool.query(
                format(`SELECT id FROM %I.books WHERE fractal_id = $1`, tenantSchema),
                [fractalIdParam]
            );
            if (bookCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            if (await totalQueueDepth() >= MAX_QUEUE_SIZE) {
                logger.warn({ queueSize: getCachedDepth() }, 'Queue full — rejecting webhook message');
                return res.status(503).json({ error: 'Server busy, please retry' });
            }

            const senderName = username || phone || email || 'External';
            await enqueueItem({
                msg: {
                    fractalId: fractalIdParam,
                    tenantSchema,
                    body: text || '',
                    senderName,
                    avatar_url: avatar_url || null,
                    media_url: media_url || null,
                    phone: phone || null,
                    email: email || null,
                    hasMedia: !!media_url
                },
                rawPayload: payloadResult.data,
                channel: 'webhook',
                messageSid: `wh_${Date.now()}_${fractalIdParam.slice(-8)}`,
                queuedAt: Date.now()
            });

            logger.info({ sender: senderName, bookId: fractalIdParam, queueDepth: getCachedDepth() }, 'Webhook: message queued');
            res.json({ success: true, message: 'Message accepted' });
        } catch (error) {
            logger.error({ err: error }, 'Webhook: error queuing message');
            res.status(500).json({ error: error.message });
        }
    });
    registeredRoutes.push('POST /api/webhook/:fractalId');

    app.get('/api/webhook/:fractalId/messages', webhookLimiter, async (req, res) => {
        try {
            const fractalIdParam = req.params.fractalId;
            const fractalIdPattern = /^bridge_[a-z][0-9a-z]_[a-zA-Z0-9]{6,32}$/;
            if (!fractalIdParam || !fractalIdPattern.test(fractalIdParam)) {
                return res.status(400).json({ error: 'Invalid book ID format' });
            }

            const fractalIdMod = require('../utils/fractal-id');
            const parsed = fractalIdMod.parse(fractalIdParam);
            if (!parsed || !parsed.tenantId) {
                return res.status(400).json({ error: 'Invalid book ID format' });
            }
            if (!Number.isInteger(parsed.tenantId) || parsed.tenantId <= 0 || parsed.tenantId > 999999) {
                return res.status(400).json({ error: 'Invalid tenant ID' });
            }

            const tenantSchema = `tenant_${parsed.tenantId}`;
            if (!VALID_SCHEMA_PATTERN.test(tenantSchema)) {
                return res.status(400).json({ error: 'Invalid tenant schema' });
            }

            const bookResult = await pool.query(
                format(`SELECT id, name, output_credentials, created_at, agent_token_hash FROM %I.books WHERE fractal_id = $1`, tenantSchema),
                [fractalIdParam]
            );
            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const tokenHash = bookResult.rows[0].agent_token_hash;
            if (!tokenHash) {
                return res.status(403).json({ error: 'Agent access not enabled for this book. Generate a token in the dashboard.' });
            }
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Authorization required. Use: Authorization: Bearer <agent_token>' });
            }
            const providedToken = authHeader.slice(7);
            const crypto = require('crypto');
            const providedHash = crypto.createHash('sha256').update(providedToken).digest('hex');
            if (!crypto.timingSafeEqual(Buffer.from(tokenHash, 'hex'), Buffer.from(providedHash, 'hex'))) {
                return res.status(401).json({ error: 'Invalid agent token' });
            }

            const book = bookResult.rows[0];
            const bookCreatedAt = new Date(book.created_at);
            let outputCredentials = book.output_credentials;
            if (typeof outputCredentials === 'string') {
                try { outputCredentials = JSON.parse(outputCredentials); } catch { outputCredentials = {}; }
            }

            const outputData = outputCredentials?.output_01;
            if (!outputData || !outputData.thread_id) {
                return res.json({ messages: [], total: 0, hasMore: false, note: 'No ledger thread configured' });
            }

            if (!thothBot || !thothBot.client || !thothBot.ready) {
                res.set('Retry-After', '5');
                return res.status(503).json({ error: 'Message reader not ready, retry shortly' });
            }

            let thread;
            try {
                thread = await thothBot.client.channels.fetch(outputData.thread_id);
            } catch (fetchErr) {
                await sleep(1000);
                try {
                    thread = await thothBot.client.channels.fetch(outputData.thread_id);
                } catch (retryErr) {
                    logger.warn({ err: retryErr.message, threadId: outputData.thread_id }, 'Webhook read: thread fetch failed after retry');
                    res.set('Retry-After', '5');
                    return res.status(503).json({ error: 'Message source temporarily unavailable' });
                }
            }
            if (!thread) {
                return res.json({ messages: [], total: 0, hasMore: false, note: 'Thread not found' });
            }

            const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
            const after = req.query.after;
            const before = req.query.before;

            if (after && !/^\d{17,20}$/.test(after)) {
                return res.status(400).json({ error: 'Invalid after cursor (must be a Discord message ID)' });
            }
            if (before && !/^\d{17,20}$/.test(before)) {
                return res.status(400).json({ error: 'Invalid before cursor (must be a Discord message ID)' });
            }
            if (after && before) {
                return res.status(400).json({ error: 'Cannot use both after and before cursors' });
            }

            const options = { force: true, limit };
            if (after) options.after = after;
            else if (before) options.before = before;

            let discordMessages;
            try {
                discordMessages = await thread.messages.fetch(options);
            } catch (msgErr) {
                await sleep(1000);
                try {
                    discordMessages = await thread.messages.fetch(options);
                } catch (retryErr) {
                    logger.warn({ err: retryErr.message, threadId: outputData.thread_id }, 'Webhook read: messages fetch failed after retry');
                    res.set('Retry-After', '5');
                    return res.status(503).json({ error: 'Message source temporarily unavailable' });
                }
            }

            const messages = Array.from(discordMessages.values())
                .filter(msg => msg.createdAt >= bookCreatedAt)
                .map(msg => {
                    const attachment = msg.attachments.size > 0 ? msg.attachments.first() : null;
                    let mediaFromEmbed = null;
                    let senderContact = null;
                    for (const embed of msg.embeds) {
                        const mediaField = embed.fields?.find(f => f.name === '📎 Media');
                        if (mediaField?.value) {
                            const match = mediaField.value.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
                            if (match) {
                                const url = match[1];
                                const contentType = embed.fields?.find(f => f.name === '📎 Media Type')?.value || 'application/octet-stream';
                                mediaFromEmbed = { url, contentType };
                            }
                        }
                        const phoneField = embed.fields?.find(f =>
                            f.name && (/[📞📱]/.test(f.name) || f.name.toLowerCase().includes('phone'))
                        );
                        if (phoneField?.value) senderContact = phoneField.value;
                    }

                    return {
                        id: msg.id,
                        sender: msg.author.username,
                        sender_contact: senderContact || null,
                        text: msg.content || (msg.embeds[0]?.description !== '_(No text content)_' ? msg.embeds[0]?.description : '') || '',
                        timestamp: msg.createdAt.toISOString(),
                        has_media: msg.attachments.size > 0 || !!mediaFromEmbed,
                        media_url: attachment ? attachment.url : (mediaFromEmbed ? mediaFromEmbed.url : null),
                        media_type: attachment ? attachment.contentType : (mediaFromEmbed ? mediaFromEmbed.contentType : null)
                    };
                });

            res.json({
                book: book.name,
                messages,
                total: messages.length,
                hasMore: discordMessages.size >= limit,
                cursor: {
                    newest: messages.length > 0 ? messages[0].id : null,
                    oldest: messages.length > 0 ? messages[messages.length - 1].id : null
                }
            });

            logger.info({ bookId: fractalIdParam, count: messages.length }, 'Webhook read: messages fetched');
        } catch (error) {
            logger.error({ err: error }, 'Webhook read: error fetching messages');
            res.set('Retry-After', '5');
            res.status(503).json({ error: 'Failed to fetch messages, retry shortly' });
        }
    });
    registeredRoutes.push('GET /api/webhook/:fractalId/messages');

    logger.info('📥 Pipe routes registered: %s', registeredRoutes.join(', '));

    return { endpoints: registeredRoutes.length, stopQueueProcessor: queueProcessor.stop };
}

module.exports = { registerPipeRoutes };

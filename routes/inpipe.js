const axios = require('axios');
const FormData = require('form-data');
const { TwilioChannel } = require('../lib/channels/twilio');
const { LineChannel } = require('../lib/channels/line');
const { EmailChannel } = require('../lib/channels/email');
const { TelegramChannel } = require('../lib/channels/telegram');
const { buildCapsule } = require('../utils/message-capsule');
const { pinJson } = require('../utils/ipfs-pinner');
const { routeUserOutput } = require('../lib/outpipes/router');
const { assertValidSchemaName, VALID_SCHEMA_PATTERN } = require('../lib/validators');
const { detectLanguage } = require('../utils/language-detector');
const format = require('pg-format');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

// Phone-bearing channels; all others store phone_number = null (Telegram, LINE, email).
// Password reset is gated on phone activation — non-phone users silent-fail on reset.
const PHONE_CHANNELS = new Set(['twilio']);

// ═══════════════════════════════════════════════════════════════
// DURABLE MESSAGE QUEUE: PostgreSQL-backed with priority + retry
// ═══════════════════════════════════════════════════════════════
// Architecture:
//   core.message_queue table with priority column (media/text).
//   Drain order: media first, then text (ORDER BY priority, created_at).
//   Atomic dequeue via UPDATE … FOR UPDATE SKIP LOCKED … RETURNING.
//   Survives restarts: stale 'processing' rows reset to 'pending' on boot.
//   Failed items retry up to MAX_RETRY_COUNT times before being dropped.
//
// Processing loop (not interval):
//   Continuous async loop with adaptive gap between messages.
//   Normal load: 500ms gap (safe: ~2/sec vs Discord's 5/5sec per route).
//   Burst mode (queue > 5): 200ms gap (~5/sec globally across routes).
//   No dead-wait: loop polls at 100ms when idle.
//
// Rate limits respected:
//   Discord API: 5 req/5sec per route — we write to different threads so
//                burst mode (200ms) stays under the global 50 req/sec cap.
//   LINE Content API: 2000 req/min — 5/sec is 300/min, well within limit.
//   Twilio webhook: 60 req/min inbound — handled by vegapunk.js rate limiter.
// ═══════════════════════════════════════════════════════════════

const IDEMPOTENCY_TTL_INTERVAL = '6 hours';
const MAX_QUEUE_SIZE = 200;
const NORMAL_GAP_MS  = 500;
const BURST_GAP_MS   = 200;
const BURST_THRESHOLD = 5;
const MAX_RETRY_COUNT = 3;

let _pool = null;
let _cachedDepth = 0;
let _depthCacheTime = 0;
const DEPTH_CACHE_TTL_MS = 200;

const MESSAGE_QUEUE = { get length() { return _cachedDepth; } };

async function totalQueueDepth() {
    const now = Date.now();
    if (now - _depthCacheTime < DEPTH_CACHE_TTL_MS) return _cachedDepth;
    try {
        const r = await _pool.query(`SELECT COUNT(*) AS c FROM core.message_queue WHERE status = 'pending'`);
        _cachedDepth = parseInt(r.rows[0].c, 10);
        _depthCacheTime = now;
    } catch (_) { /* use cached */ }
    return _cachedDepth;
}

async function enqueueItem(item) {
    const priority = item.msg.hasMedia ? 'media' : 'text';
    await _pool.query(
        `INSERT INTO core.message_queue (priority, payload, status) VALUES ($1, $2, 'pending')`,
        [priority, JSON.stringify(item)]
    );
    _depthCacheTime = 0;
}

async function dequeueItem() {
    const r = await _pool.query(`
        UPDATE core.message_queue
        SET status = 'processing', updated_at = NOW()
        WHERE id = (
            SELECT id FROM core.message_queue
            WHERE status = 'pending' AND retry_count < $1
            ORDER BY CASE WHEN priority = 'media' THEN 0 ELSE 1 END, created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, payload
    `, [MAX_RETRY_COUNT]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const item = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    item._queueId = row.id;
    return item;
}

async function markQueueDone(queueId) {
    await _pool.query(`UPDATE core.message_queue SET status = 'done', updated_at = NOW() WHERE id = $1`, [queueId]);
    _depthCacheTime = 0;
}

async function markQueueRetry(queueId) {
    const r = await _pool.query(
        `UPDATE core.message_queue SET retry_count = retry_count + 1, updated_at = NOW(), status = CASE WHEN retry_count + 1 >= $2 THEN 'failed' ELSE 'pending' END WHERE id = $1 RETURNING status`,
        [queueId, MAX_RETRY_COUNT]
    );
    _depthCacheTime = 0;
    return r.rows[0]?.status;
}

async function recoverStaleProcessing(logger) {
    try {
        const r = await _pool.query(`
            UPDATE core.message_queue
            SET status = 'pending', updated_at = NOW()
            WHERE status = 'processing'
            RETURNING id
        `);
        if (r.rowCount > 0) {
            logger.info({ recovered: r.rowCount }, `📥 Recovered ${r.rowCount} in-flight messages back to pending`);
        }
        const pending = await _pool.query(`SELECT COUNT(*) AS c FROM core.message_queue WHERE status = 'pending'`);
        const depth = parseInt(pending.rows[0].c, 10);
        if (depth > 0) {
            logger.info({ queueDepth: depth }, `📥 Resuming with ${depth} queued messages from previous session`);
        }
    } catch (err) {
        logger.error({ err }, 'Queue recovery failed');
    }
}

async function cleanupDoneMessages(pool, logger) {
    try {
        const r = await pool.query(`DELETE FROM core.message_queue WHERE status IN ('done', 'failed') AND updated_at < NOW() - INTERVAL '24 hours'`);
        if (r.rowCount > 0) {
            logger.info({ purged: r.rowCount }, '🧹 Purged completed/failed queue entries');
        }
    } catch (err) {
        logger.error({ err }, 'Queue cleanup failed');
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function registerInpipeRoutes(app, deps) {
    const { pool, bots, helpers, constants, logger } = deps;
    const { hermes: hermesBot, thoth: thothBot } = bots || {};
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    const LIMBO_THREAD_ID = constants?.LIMBO_THREAD_ID;
    const HERMES_TOKEN = constants?.HERMES_TOKEN || process.env.HERMES_TOKEN;
    
    if (!pool) {
        logger.warn('Inpipe routes: pool not available, skipping registration');
        return;
    }

    _pool = pool;
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

    const channelRegistry = { twilio: twilioChannel, line: lineChannel, email: emailChannel, telegram: telegramChannel };
    startQueueProcessor({ ...deps, channelRegistry });
    
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
                logger.warn({ queueSize: _cachedDepth }, 'Queue full - rejecting message');
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
                queueDepth: _cachedDepth
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
                    logger.warn({ queueSize: _cachedDepth }, 'Queue full — rejecting Line message');
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
                    queueDepth: _cachedDepth
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
                    logger.warn({ queueSize: _cachedDepth }, 'Queue full — rejecting email message');
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
                    queueDepth: _cachedDepth
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
                    logger.warn({ queueSize: _cachedDepth }, 'Queue full — rejecting Telegram message');
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
                    queueDepth: _cachedDepth
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
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const bookResult = await client.query(
                    format(`SELECT id, fractal_id, name, output_01_url, output_0n_url, output_credentials, outpipes_user FROM %I.books WHERE fractal_id = $1`, tenantSchema),
                    [fractalIdParam]
                );
                if (bookResult.rows.length === 0) {
                    await client.query('ROLLBACK');
                    client.release();
                    return res.status(404).json({ error: 'Book not found' });
                }
                const book = bookResult.rows[0];
                if (book && typeof book.output_credentials === 'string') {
                    try {
                        book.output_credentials = JSON.parse(book.output_credentials);
                    } catch (jsonError) {
                        logger.error({ bookId: fractalIdParam, err: jsonError }, 'Corrupted output_credentials for book');
                        book.output_credentials = {};
                    }
                }
                const senderName = username || phone || email || 'External';
                const discordPayload = {
                    username: senderName,
                    avatar_url: avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
                    content: text || '',
                    embeds: []
                };
                if (media_url) {
                    discordPayload.embeds.push({ image: { url: media_url } });
                }
                const threadName = book.output_credentials?.thread_name;
                const threadId = book.output_credentials?.thread_id;
                const sendToLedger = helpers?.sendToLedger;
                if (sendToLedger) {
                    await sendToLedger(discordPayload, {
                        isMedia: !!media_url,
                        threadName,
                        threadId
                    }, book);
                }
                const capsule = {
                    sender: senderName,
                    text: text || '',
                    media_url: media_url || null,
                    avatar_url: avatar_url || null,
                    book_name: book.name || null,
                    timestamp: new Date().toISOString()
                };
                await routeUserOutput(capsule, { isMedia: !!media_url }, book);
                await client.query('COMMIT');
                client.release();
                logger.info({ sender: senderName, bookId: fractalIdParam }, 'Webhook: forwarded message to book');
                res.json({ success: true, message: 'Message forwarded to Webhook' });
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    logger.error({ err: rollbackError }, 'ROLLBACK failed (connection likely broken)');
                } finally {
                    client.release();
                }
                throw error;
            }
        } catch (error) {
            logger.error({ err: error }, 'Webhook: error processing request');
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
                format(`SELECT id, name, output_credentials, created_at FROM %I.books WHERE fractal_id = $1`, tenantSchema),
                [fractalIdParam]
            );
            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
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
                return res.status(503).json({ error: 'Message reader not ready' });
            }

            const thread = await thothBot.client.channels.fetch(outputData.thread_id);
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

            const discordMessages = await thread.messages.fetch(options);

            const messages = Array.from(discordMessages.values())
                .filter(msg => msg.createdAt >= bookCreatedAt)
                .map(msg => {
                    const attachment = msg.attachments.size > 0 ? msg.attachments.first() : null;
                    let mediaFromEmbed = null;
                    let senderContact = null;
                    for (const embed of msg.embeds) {
                        const mediaField = embed.fields?.find(f => f.name === '📎 Media');
                        if (mediaField?.value) {
                            const match = mediaField.value.match(/\[(.*?)\]\((.*?)\)/);
                            if (match) mediaFromEmbed = { url: match[2], contentType: match[1] };
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
            res.status(500).json({ error: 'Failed to fetch messages' });
        }
    });
    registeredRoutes.push('GET /api/webhook/:fractalId/messages');

    logger.info('📥 Inpipe routes registered: %s', registeredRoutes.join(', '));

    return { endpoints: registeredRoutes.length };
}

// Adaptive async queue processor — channel-agnostic
// Uses a continuous loop (not setInterval) so there is no 1-tick dead-wait
// between messages; instead an explicit gap is inserted after each message.
// Gap adapts to queue depth: burst mode shortens it when load is high.
// Dispatches via item.channel — adding a channel requires zero changes here.
function startQueueProcessor(deps) {
    const { logger, channelRegistry } = deps;

    logger.info({
        normalGapMs: NORMAL_GAP_MS,
        burstGapMs: BURST_GAP_MS,
        burstThreshold: BURST_THRESHOLD
    }, '⚙️ Queue processor started (PostgreSQL-backed, adaptive async loop)');

    (async function loop() {
        while (true) {
            let item;
            try {
                item = await dequeueItem();
            } catch (err) {
                logger.error({ err }, 'dequeueItem failed');
                await sleep(1000);
                continue;
            }

            if (!item) {
                await sleep(100);
                continue;
            }

            const startTime = Date.now();
            const tier = item.msg.hasMedia ? 'media' : 'text';
            const channel = channelRegistry[item.channel];

            if (!channel) {
                logger.error({ channelName: item.channel, messageSid: item.messageSid }, 'Unknown channel in queue item — marking done');
                await markQueueDone(item._queueId).catch(() => {});
                continue;
            }

            let processed = false;
            try {
                await processQueuedMessage(item.msg, item.rawPayload, channel, deps);
                processed = true;
            } catch (error) {
                const newStatus = await markQueueRetry(item._queueId).catch(() => 'unknown');
                const depth = await totalQueueDepth();
                const isFailed = newStatus === 'failed';
                logger[isFailed ? 'warn' : 'error']({
                    error: error.message,
                    messageSid: item.messageSid,
                    tier,
                    status: newStatus,
                    queueDepth: depth
                }, isFailed ? 'Queued message permanently failed (max retries)' : 'Failed to process queued message — will retry');
            }

            if (processed) {
                await markQueueDone(item._queueId).catch(err =>
                    logger.error({ err, queueId: item._queueId }, 'markQueueDone failed — row will be recovered on restart')
                );
                const depth = await totalQueueDepth();
                logger.info({
                    messageSid: item.messageSid,
                    tier,
                    duration: Date.now() - startTime,
                    queueDepth: depth
                }, 'Queued message processed');
            }

            const depth = await totalQueueDepth();
            const gap = depth >= BURST_THRESHOLD ? BURST_GAP_MS : NORMAL_GAP_MS;
            const elapsed = Date.now() - startTime;
            const wait = Math.max(0, gap - elapsed);
            if (wait > 0) await sleep(wait);
        }
    })();
}

// Process a single queued message
async function processQueuedMessage(msg, rawPayload, channel, deps) {
    const { pool, logger } = deps;
    
    const routingResult = await routeMessage(pool, msg, logger);
    
    if (!routingResult.bookRecord) {
        await handleLimboMessageAsync(channel, msg, rawPayload, deps);
        return;
    }
    
    const { bookRecord } = routingResult;
    
    if (bookRecord.status === 'pending') {
        await handlePendingBookAsync(channel, msg, bookRecord, deps);
        return;
    }
    
    if (bookRecord.status === 'active') {
        await handleActiveBookAsync(channel, msg, rawPayload, bookRecord, deps);
        return;
    }
    
    logger.warn({ status: bookRecord.status, fractalId: bookRecord.fractal_id }, 'Unknown book status');
}

// Cleanup old idempotency entries from DB (DELETE rows older than TTL window)
async function cleanupIdempotencyCache(pool, logger) {
    try {
        const result = await pool.query(
            `DELETE FROM core.processed_sids
             WHERE processed_at < NOW() - INTERVAL '${IDEMPOTENCY_TTL_INTERVAL}'`
        );
        const cleaned = result.rowCount || 0;
        if (cleaned > 0) {
            logger.info({ cleaned }, 'Idempotency DB cleanup');
        }
    } catch (err) {
        logger.warn({ err: err.message }, 'Idempotency DB cleanup error (non-fatal)');
    }
}

async function routeMessage(pool, msg, logger) {
    let bookRecord = null;
    let routingMethod = 'unknown';
    
    if (msg.joinCode) {
        logger.info({ joinCode: msg.joinCode }, 'Join code provided - checking registry');
        const result = await pool.query(`
            SELECT id, tenant_schema, tenant_email, fractal_id, book_name, join_code,
                   outpipe_ledger, outpipes_user, status, phone_number, creator_phone
            FROM core.book_registry
            WHERE LOWER(join_code) = LOWER($1)
        `, [msg.joinCode]);
        
        if (result.rows.length > 0) {
            bookRecord = result.rows[0];
            routingMethod = 'join_code';
            logger.info({ fractalId: bookRecord.fractal_id, bookName: bookRecord.book_name }, 'Found via join code');
        } else {
            logger.info({ joinCode: msg.joinCode }, 'Join code not found in registry');
        }
    } else if (msg.channel === 'telegram') {
        // Telegram routes via channel_identifiers (not book_engaged_phones)
        logger.info({ userId: msg.phone }, 'Telegram: no join code — using channel_identifiers lookup');
        const result = await pool.query(`
            SELECT br.id, br.tenant_schema, br.tenant_email, br.fractal_id, br.book_name, br.join_code,
                   br.outpipe_ledger, br.outpipes_user, br.status, br.phone_number, br.creator_phone, br.updated_at,
                   ci.created_at AS last_engaged_at
            FROM core.channel_identifiers ci
            JOIN core.book_registry br ON br.fractal_id = ci.book_fractal_id
            WHERE ci.channel = 'telegram' AND ci.external_id = $1 AND br.status = 'active'
            LIMIT 1
        `, [String(msg.phone)]);

        if (result.rows.length > 0) {
            bookRecord = result.rows[0];
            routingMethod = 'channel_id';
            logger.info({ fractalId: bookRecord.fractal_id, bookName: bookRecord.book_name }, 'Telegram: found via channel_identifiers');
        } else {
            logger.info({ userId: msg.phone }, 'Telegram: no active book found in channel_identifiers');
        }
    } else {
        logger.info({ phone: msg.phone }, 'No join code - using phone lookup');
        const result = await pool.query(`
            SELECT br.id, br.tenant_schema, br.tenant_email, br.fractal_id, br.book_name, br.join_code,
                   br.outpipe_ledger, br.outpipes_user, br.status, br.phone_number, br.creator_phone, br.updated_at,
                   ep.last_engaged_at
            FROM core.book_engaged_phones ep
            JOIN core.book_registry br ON br.id = ep.book_registry_id
            WHERE ep.phone = $1 AND br.status = 'active'
            ORDER BY ep.last_engaged_at DESC
            LIMIT 1
        `, [msg.phone]);
        
        if (result.rows.length > 0) {
            bookRecord = result.rows[0];
            routingMethod = 'phone';
            logger.info({ fractalId: bookRecord.fractal_id, bookName: bookRecord.book_name }, 'Found via phone');
        } else {
            logger.info({ phone: msg.phone }, 'No active book found for phone');
        }
    }
    
    return { bookRecord, routingMethod };
}


async function sendToDiscordThread(threadId, payload, media, deps) {
    const hermesToken = deps?.constants?.HERMES_TOKEN || process.env.HERMES_TOKEN;
    const logger = deps?.logger;

    const doSend = async () => {
        if (media) {
            const form = new FormData();
            form.append('files[0]', media.buffer, {
                filename: media.filename,
                contentType: media.contentType
            });
            form.append('payload_json', JSON.stringify(payload));
            return await axios.post(`https://discord.com/api/v10/channels/${threadId}/messages`, form, {
                headers: {
                    'Authorization': `Bot ${hermesToken}`,
                    ...form.getHeaders()
                }
            });
        } else {
            return await axios.post(`https://discord.com/api/v10/channels/${threadId}/messages`, payload, {
                headers: {
                    'Authorization': `Bot ${hermesToken}`,
                    'Content-Type': 'application/json'
                }
            });
        }
    };

    const trySend = async (attempt) => {
        try {
            return await doSend();
        } catch (err) {
            const status = err?.response?.status;

            // Discord rate limit — honor retry_after and retry once
            if (status === 429 && attempt < 2) {
                const retryAfterMs = Math.ceil((err.response.data?.retry_after || 1) * 1000);
                if (logger) logger.warn({ threadId, retryAfterMs, attempt }, '⏳ Discord 429 — backing off');
                await sleep(retryAfterMs);
                return trySend(attempt + 1);
            }

            // Thread archived — unarchive and retry once
            const isArchived = status === 403 && err?.response?.data?.code === 50083;
            if (isArchived && attempt < 2) {
                if (logger) logger.info({ threadId }, '🔓 Thread archived — unarchiving and retrying');
                await axios.patch(
                    `https://discord.com/api/v10/channels/${threadId}`,
                    { archived: false, auto_archive_duration: 10080 },
                    { headers: { 'Authorization': `Bot ${hermesToken}`, 'Content-Type': 'application/json' } }
                );
                return trySend(attempt + 1);
            }

            throw err;
        }
    };

    return trySend(1);
}

function sendChannelResponse(res, channel) {
    const response = channel.getEmptyResponse();
    if (response.contentType) {
        res.set('Content-Type', response.contentType);
    }
    return res.status(response.status).send(response.body);
}

// ═══════════════════════════════════════════════════════════════
// ASYNC HANDLERS: "Send and Fire" - Discord webhook as source of truth
// No Twilio reply since we already ACK'd immediately
// ═══════════════════════════════════════════════════════════════

// ── Capsule pipeline helper ───────────────────────────────────────────────────
// Shared by all active-book message paths. Fire-and-forget — never blocks the
// Discord write. Writes ledger row immediately (CIDs null), fills in as pins resolve.
async function processCapsule(book, bookRecord, msg, media, discordResponse, deps) {
    const { pool, logger } = deps;
    const tenantIdMatch = bookRecord.tenant_schema?.match(/tenant_(\d+)/);
    const capsuleTenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
    const langResult = msg.body ? detectLanguage(msg.body) : { lang: null, confidence: 0 };
    const detectedLang = langResult.confidence >= 0.3 ? langResult.lang : null;
    const capsule = buildCapsule({
        bookFractalId: book.fractal_id,
        tenantId: capsuleTenantId,
        phone: msg.phone,
        body: msg.body,
        media,
        timestamp: new Date().toISOString()
    });
    if (media && capsule.attachments.length > 0) {
        const cdnUrl = discordResponse?.data?.attachments?.[0]?.url;
        if (cdnUrl) capsule.attachments[0].attachment_url = cdnUrl;
    }
    ;(async () => {
        try {
            if (pool) {
                const env = deps?.constants?.IS_PROD ? 'prod' : 'dev';
                await pool.query(
                    `INSERT INTO core.message_ledger
                     (message_fractal_id, book_fractal_id, sender_hash, content_hash,
                      has_attachment, env, detected_lang)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (message_fractal_id) DO NOTHING`,
                    [
                        capsule.message_fractal_id,
                        capsule.book_fractal_id,
                        capsule.sender_hash,
                        capsule.content_hash,
                        capsule.attachments.length > 0,
                        env,
                        detectedLang
                    ]
                );
            }
            const jsonResult = await pinJson(capsule);
            if (jsonResult?.cid && pool) {
                await pool.query(
                    `UPDATE core.message_ledger SET ipfs_cid = $1 WHERE message_fractal_id = $2`,
                    [jsonResult.cid, capsule.message_fractal_id]
                );
            }
            if (media?.buffer && capsule.attachments[0]?.attachment_url) {
                if (pool) {
                    await pool.query(
                        `UPDATE core.message_ledger SET attachment_cid = $1 WHERE message_fractal_id = $2`,
                        [capsule.attachments[0].attachment_url, capsule.message_fractal_id]
                    );
                }
            }
            logger.info({
                msgFractalId: capsule.message_fractal_id,
                ipfsCid: jsonResult?.cid || null
            }, '🜁 Capsule sealed');
        } catch (err) {
            logger.warn({ err: err.message }, '⚠️ Capsule pipeline error (non-fatal)');
        }
    })();
}

async function handleLimboMessageAsync(channel, msg, rawPayload, deps) {
    const { pool, constants, logger } = deps;
    const LIMBO_THREAD_ID = constants?.LIMBO_THREAD_ID;
    
    logger.info({ phone: msg.phone }, 'Async: Routing to limbo (no valid join code)');
    
    const limboPayload = {
        embeds: [{
            title: `Limbo Message (No Join Code)`,
            description: msg.body || '_(No text content)_',
            color: 0xFF6B6B,
            fields: [
                { name: 'Phone', value: msg.phone, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true },
                { name: 'Status', value: 'No valid join code found', inline: false },
                { name: 'Message', value: `\`${(msg.body || '').substring(0, 100)}\``, inline: false }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'User needs to send a valid join code (e.g., "bookname-abc123")' }
        }]
    };
    
    let media = null;
    if (msg.hasMedia) {
        media = await channel.downloadMedia(rawPayload.mediaUrl, rawPayload.mediaContentType);
        if (media) {
            limboPayload.embeds[0].fields.push({ 
                name: 'Media', 
                value: `${media.contentType} (${(media.buffer.length / 1024).toFixed(1)} KB)`,
                inline: false 
            });
        }
    }
    
    // SEND TO DISCORD (source of truth)
    try {
        await sendToDiscordThread(LIMBO_THREAD_ID, limboPayload, media, deps);
        logger.info({ phone: msg.phone }, 'Async: Limbo message forwarded to Discord');
    } catch (error) {
        logger.error({ error: error.message }, 'Async: Failed to forward limbo message');
    }
    
    // FIRE: Send Twilio reply (non-blocking, no need to wait)
    const domain = process.env.REPLIT_DOMAINS?.split(',')[0] || 'your dashboard';
    channel.sendReply(msg.rawFrom, 
        `Welcome to Nyanbook! To activate your book, send your join code (format: bookname-abc123).\n\nCreate a book at: ${domain}`
    ).catch(err => logger.warn({ error: err.message }, 'Async: Twilio reply failed (non-critical)'));
}

async function handlePendingBookAsync(channel, msg, bookRecord, deps) {
    const { pool, bots, logger } = deps;
    const { hermes: hermesBot } = bots;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id, phone: msg.phone }, 'Async: Activating pending book');
    
    const bookIdResult = await pool.query(`
        SELECT id FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookIdResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Async: Book not found in tenant schema');
        return;
    }
    
    const bookId = bookIdResult.rows[0].id;

    // phone_number stores E.164 only — null for non-phone channels (Line, Telegram, email).
    const phoneToStore = PHONE_CHANNELS.has(msg.channel) ? msg.phone : null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            UPDATE core.book_registry 
            SET phone_number = $1, creator_phone = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
            WHERE id = $2
        `, [phoneToStore, bookRecord.id]);
        await client.query(`
            UPDATE ${tenantSchema}.books 
            SET status = 'active'
            WHERE id = $1
        `, [bookId]);
        await client.query('COMMIT');
    } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
    } finally {
        client.release();
    }
    
    logger.info({ fractalId: bookRecord.fractal_id, bookId, phone: msg.phone, channel: msg.channel }, 'Async: Activated book');
    
    await pool.query(`
        INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
        VALUES ($1, $2, TRUE, NOW(), NOW())
        ON CONFLICT (book_registry_id, phone) DO UPDATE 
        SET last_engaged_at = NOW(), is_creator = TRUE
    `, [bookRecord.id, msg.phone]);

    // Telegram: write to channel_identifiers + activate book_channels row.
    // Always upsert (DO UPDATE) so relinking always wins — latest join code
    // takes over immediately; messages never fire to a previous book by mistake.
    if (msg.channel === 'telegram') {
        // Step 1: Check if previously linked to a different book
        const prevLink = await pool.query(`
            SELECT book_fractal_id, tenant_schema FROM core.channel_identifiers
            WHERE channel = 'telegram' AND external_id = $1
        `, [String(msg.phone)]);
        if (prevLink.rows.length > 0 && prevLink.rows[0].book_fractal_id !== bookRecord.fractal_id) {
            const oldFractal = prevLink.rows[0].book_fractal_id;
            const oldSchema  = assertValidSchemaName(prevLink.rows[0].tenant_schema);
            try {
                await pool.query(`
                    UPDATE ${oldSchema}.book_channels
                    SET status = 'inactive', updated_at = NOW()
                    WHERE book_fractal_id = $1 AND direction = 'inpipe' AND channel = 'telegram'
                `, [oldFractal]);
                logger.info({ oldFractal, newFractal: bookRecord.fractal_id }, 'Async: Telegram old book_channels deactivated on relink');
            } catch (e) {
                logger.warn({ err: e.message }, 'Async: Telegram old book_channels deactivation skipped');
            }
        }
        // Step 2: Upsert — always points to the latest book
        await pool.query(`
            INSERT INTO core.channel_identifiers (channel, external_id, book_fractal_id, tenant_schema)
            VALUES ('telegram', $1, $2, $3)
            ON CONFLICT (channel, external_id)
            DO UPDATE SET book_fractal_id = EXCLUDED.book_fractal_id,
                          tenant_schema   = EXCLUDED.tenant_schema
        `, [String(msg.phone), bookRecord.fractal_id, tenantSchema]);
        // Step 3: Activate new book's book_channels row
        await pool.query(`
            UPDATE ${tenantSchema}.book_channels
            SET status = 'active', updated_at = NOW()
            WHERE book_fractal_id = $1 AND direction = 'inpipe' AND channel = 'telegram'
        `, [bookRecord.fractal_id]);
        logger.info({ fractalId: bookRecord.fractal_id }, 'Async: Telegram channel_identifiers + book_channels activated (latest wins)');
    }
    
    if (hermesBot && hermesBot.isReady()) {
        try {
            const tenantIdMatch = tenantSchema.match(/tenant_(\d+)/);
            const tenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
            
            // outpipes_user is JSONB in core.book_registry — pg auto-parses it to an array.
            const outpipesUser = Array.isArray(bookRecord.outpipes_user) ? bookRecord.outpipes_user : [];
            let userOutputUrl = outpipesUser.length > 0 ? (outpipesUser[0]?.url || null) : null;
            
            logger.info({ bookName: bookRecord.book_name, tenantId, bookId, hasUserOutput: !!userOutputUrl }, 'Async: Hermes creating dual outputs');
            const dualThreads = await hermesBot.createDualThreadsForBook(
                bookRecord.outpipe_ledger,
                userOutputUrl,
                bookRecord.book_name,
                tenantId,
                bookId
            );
            
            const outputDestinations = {};
            if (dualThreads.output_01) outputDestinations.output_01 = dualThreads.output_01;
            if (dualThreads.output_0n) outputDestinations.output_0n = dualThreads.output_0n;
            
            await pool.query(`
                UPDATE ${tenantSchema}.books 
                SET output_credentials = COALESCE(output_credentials, '{}'::jsonb) || $1::jsonb
                WHERE id = $2
            `, [JSON.stringify(outputDestinations), bookId]);
            
            // SEND TO DISCORD (source of truth)
            const activationEmbed = {
                embeds: [{
                    title: `Book Activated`,
                    description: `Join code: \`${msg.joinCode}\``,
                    color: 0x00FF00,
                    fields: [
                        { name: 'Phone', value: msg.phone, inline: true },
                        { name: 'Book', value: bookRecord.book_name, inline: true },
                        { name: 'Fractal ID', value: bookRecord.fractal_id, inline: false }
                    ],
                    timestamp: new Date().toISOString()
                }]
            };
            
            if (dualThreads.output_01?.thread_id) {
                await sendToDiscordThread(dualThreads.output_01.thread_id, activationEmbed, null, deps);
            }
            
            logger.info({ 
                threadId: dualThreads.output_01?.thread_id, 
                hasUserOutput: !!dualThreads.output_0n 
            }, 'Async: Hermes dual-thread setup complete');
        } catch (error) {
            logger.error({ error: error.message }, 'Async: Failed to create Hermes threads');
        }
    }
    
    // FIRE: Send Twilio reply (non-blocking)
    channel.sendReply(msg.rawFrom, 
        `Book activated! Your messages will now be saved to "${bookRecord.book_name}". Send anything to test it out!`
    ).catch(err => logger.warn({ error: err.message }, 'Async: Twilio activation reply failed (non-critical)'));
}

async function handleActiveBookAsync(channel, msg, rawPayload, bookRecord, deps) {
    const { pool, logger } = deps;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id }, 'Async: Forwarding message to active book');
    
    const bookDetailsResult = await pool.query(`
        SELECT id, name, fractal_id, output_credentials, outpipes_user
        FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookDetailsResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Async: Book not found in tenant schema');
        return;
    }
    
    const book = bookDetailsResult.rows[0];
    
    // Track engagement (non-blocking on failure)
    try {
        await pool.query(`
            INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
            VALUES ($1, $2, FALSE, NOW(), NOW())
            ON CONFLICT (book_registry_id, phone) DO UPDATE 
            SET last_engaged_at = NOW()
        `, [bookRecord.id, msg.phone]);
        logger.info({ phone: msg.phone, fractalId: bookRecord.fractal_id }, 'Async: Tracked engagement');
    } catch (error) {
        logger.error({ error: error.message }, 'Async: Could not track engagement');
    }
    
    const outputCreds = book.output_credentials || {};
    const output01 = outputCreds.output_01;
    
    const isCreator = (bookRecord.creator_phone && msg.phone === bookRecord.creator_phone) ||
                      (!bookRecord.creator_phone && msg.phone === bookRecord.phone_number);
    
    const embed = {
        description: msg.body || '_(No text content)_',
        color: isCreator ? 0x25D366 : 0x7289DA,
        fields: [
            { name: 'Phone', value: msg.phone, inline: true },
            { name: 'Book', value: book.name, inline: true },
            { name: 'Time', value: new Date().toLocaleString(), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    
    let media = null;
    if (msg.hasMedia) {
        media = await channel.downloadMedia(rawPayload.mediaUrl, rawPayload.mediaContentType);
        if (media) {
            embed.fields.push({ 
                name: 'Media', 
                value: `${media.contentType} (${(media.buffer.length / 1024).toFixed(1)} KB)`,
                inline: false 
            });
        } else {
            embed.fields.push({ 
                name: 'Media (download failed)', 
                value: `[${rawPayload.mediaContentType || 'attachment'}](${rawPayload.mediaUrl})`,
                inline: false 
            });
        }
    }
    
    // SEND TO DISCORD (source of truth) - Ledger thread
    let discordResponse = null;
    if (output01?.type === 'thread' && output01?.thread_id) {
        try {
            discordResponse = await sendToDiscordThread(output01.thread_id, { embeds: [embed] }, media, deps);
            logger.info({ threadId: output01.thread_id }, 'Async: Sent to Ledger thread');
        } catch (error) {
            logger.error({ error: error.message }, 'Async: Failed to send to Ledger');
        }
    }
    
    // OUTPUT #0n: fractal user outpipes (discord webhook / email / custom webhook).
    // routeUserOutput handles both typed outpipes_user and legacy output_credentials.webhooks
    // fallback in one place — book must include outpipes_user from the re-query above.
    // media_url uses the Discord CDN attachment URL (stable) when available.
    try {
        const outpipeCapsule = {
            sender: msg.phone,
            text:   msg.body || '',
            media_url:  discordResponse?.data?.attachments?.[0]?.url || null,
            book_name:  book.name || null,
            timestamp:  new Date().toISOString()
        };
        await routeUserOutput(outpipeCapsule, { isMedia: !!media }, book, { pool, tenantSchema });
    } catch (err) {
        logger.warn({ err: err.message }, 'Async: routeUserOutput error (non-fatal)');
    }

    // ── Capsule pipeline (fire-and-forget — never blocks Discord write) ──────
    processCapsule(book, bookRecord, msg, media, discordResponse, deps);
}

module.exports = { registerInpipeRoutes };

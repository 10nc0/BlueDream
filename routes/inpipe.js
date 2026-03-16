const axios = require('axios');
const FormData = require('form-data');
const { TwilioChannel } = require('../lib/channels/twilio');
const { buildCapsule } = require('../utils/message-capsule');
const { pinJson, pinBuffer } = require('../utils/ipfs-pinner');

// ═══════════════════════════════════════════════════════════════
// BURST MITIGATION: In-memory message queue with rate-aligned processing
// ═══════════════════════════════════════════════════════════════
// Rate limits respected:
// - Twilio webhook: 60 req/min (our limiter in vegapunk.js)
// - Discord API: ~5 messages/5 sec per channel
// Processing rate: 1 msg/sec (safe for both limits)
// ═══════════════════════════════════════════════════════════════

const MESSAGE_QUEUE = [];
const PROCESSED_SIDS = new Map(); // MessageSid -> timestamp (idempotency guard)
const PROCESSING_INTERVAL_MS = 1000; // 1 msg/sec (aligns with 60/min webhook + Discord limits)
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes - clear old SIDs
const MAX_QUEUE_SIZE = 100; // Prevent memory exhaustion

let isProcessing = false;
let processorInterval = null;

function registerInpipeRoutes(app, deps) {
    const { pool, bots, helpers, constants, logger } = deps;
    const { hermes: hermesBot } = bots || {};
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    const LIMBO_THREAD_ID = constants?.LIMBO_THREAD_ID;
    const HERMES_TOKEN = constants?.HERMES_TOKEN || process.env.HERMES_TOKEN;
    
    if (!pool) {
        logger.warn('Inpipe routes: pool not available, skipping registration');
        return;
    }
    
    const twilioChannel = new TwilioChannel({ logger });
    twilioChannel.initialize().catch(err => logger.error({ err }, 'TwilioChannel init failed'));
    logger.info('Registering inpipe routes: POST /api/twilio/webhook');
    
    // Start queue processor
    startQueueProcessor(twilioChannel, deps);
    
    // Cleanup old idempotency entries every minute
    setInterval(() => cleanupIdempotencyCache(logger), 60 * 1000);
    
    app.post('/api/twilio/webhook', async (req, res) => {
        try {
            const rawPayload = twilioChannel.parsePayload(req);
            const messageSid = rawPayload.MessageSid || rawPayload.SmsSid;
            
            // IDEMPOTENCY GUARD: Prevent duplicate processing from Twilio retries
            if (messageSid && PROCESSED_SIDS.has(messageSid)) {
                logger.info({ messageSid }, 'Duplicate message detected - already processed');
                return sendChannelResponse(res, twilioChannel);
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
            if (MESSAGE_QUEUE.length >= MAX_QUEUE_SIZE) {
                logger.warn({ queueSize: MESSAGE_QUEUE.length }, 'Queue full - rejecting message');
                return res.status(503).send('Server busy, please retry');
            }
            
            // Mark as seen immediately (before queuing)
            if (messageSid) {
                PROCESSED_SIDS.set(messageSid, Date.now());
            }
            
            // QUEUE MESSAGE for async processing
            MESSAGE_QUEUE.push({
                msg,
                rawPayload,
                messageSid,
                queuedAt: Date.now()
            });
            
            logger.info({ 
                messageSid, 
                queueSize: MESSAGE_QUEUE.length 
            }, 'Message queued for processing');
            
            // IMMEDIATE ACK to Twilio (prevents timeout retries)
            return sendChannelResponse(res, twilioChannel);
            
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Twilio webhook error');
            const response = twilioChannel.getEmptyResponse();
            res.status(500).send(response.body);
        }
    });
    
}

// Sequential queue processor at 1 msg/sec
function startQueueProcessor(twilioChannel, deps) {
    const { logger } = deps;
    
    if (processorInterval) {
        clearInterval(processorInterval);
    }
    
    processorInterval = setInterval(async () => {
        if (isProcessing || MESSAGE_QUEUE.length === 0) {
            return;
        }
        
        isProcessing = true;
        const item = MESSAGE_QUEUE.shift();
        
        try {
            const startTime = Date.now();
            await processQueuedMessage(item.msg, item.rawPayload, twilioChannel, deps);
            const duration = Date.now() - startTime;
            
            logger.info({ 
                messageSid: item.messageSid,
                duration,
                queueRemaining: MESSAGE_QUEUE.length
            }, 'Queued message processed');
            
        } catch (error) {
            logger.error({ 
                error: error.message, 
                messageSid: item.messageSid,
                queueRemaining: MESSAGE_QUEUE.length
            }, 'Failed to process queued message');
        } finally {
            isProcessing = false;
        }
    }, PROCESSING_INTERVAL_MS);
    
    logger.info({ intervalMs: PROCESSING_INTERVAL_MS }, 'Queue processor started');
}

// Process a single queued message
async function processQueuedMessage(msg, rawPayload, twilioChannel, deps) {
    const { pool, logger } = deps;
    
    const routingResult = await routeMessage(pool, msg, logger);
    
    if (!routingResult.bookRecord) {
        await handleLimboMessageAsync(twilioChannel, msg, rawPayload, deps);
        return;
    }
    
    const { bookRecord, routingMethod } = routingResult;
    
    if (bookRecord.status === 'pending') {
        await handlePendingBookAsync(twilioChannel, msg, bookRecord, deps);
        return;
    }
    
    if (bookRecord.status === 'active') {
        await handleActiveBookAsync(twilioChannel, msg, rawPayload, bookRecord, deps);
        return;
    }
    
    logger.warn({ status: bookRecord.status, fractalId: bookRecord.fractal_id }, 'Unknown book status');
}

// Cleanup old idempotency entries
function cleanupIdempotencyCache(logger) {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sid, timestamp] of PROCESSED_SIDS.entries()) {
        if (now - timestamp > IDEMPOTENCY_TTL_MS) {
            PROCESSED_SIDS.delete(sid);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        logger.info({ cleaned, remaining: PROCESSED_SIDS.size }, 'Idempotency cache cleanup');
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

async function handleLimboMessage(res, channel, msg, rawPayload, deps) {
    const { pool, constants, logger } = deps;
    const LIMBO_THREAD_ID = constants?.LIMBO_THREAD_ID;
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    
    logger.info({ phone: msg.phone }, 'Routing to limbo (no valid join code)');
    
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
    
    try {
        await sendToDiscordThread(LIMBO_THREAD_ID, limboPayload, media, deps);
        logger.info({ phone: msg.phone }, 'Limbo message forwarded to t1-b1 thread');
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to forward limbo message');
    }
    
    const domain = process.env.REPLIT_DOMAINS?.split(',')[0] || 'your dashboard';
    await channel.sendReply(msg.rawFrom, 
        `Welcome to Nyanbook! To activate your book, send your join code (format: bookname-abc123).\n\nCreate a book at: ${domain}`
    );
    
    return sendChannelResponse(res, channel);
}

async function handlePendingBook(res, channel, msg, bookRecord, deps) {
    const { pool, bots, logger } = deps;
    const { hermes: hermesBot } = bots;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id, phone: msg.phone }, 'Activating pending book');
    
    const bookIdResult = await pool.query(`
        SELECT id FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookIdResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Book not found in tenant schema');
        return sendChannelResponse(res, channel);
    }
    
    const bookId = bookIdResult.rows[0].id;
    
    await pool.query(`
        UPDATE core.book_registry 
        SET phone_number = $1, creator_phone = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
        WHERE id = $2
    `, [msg.phone, bookRecord.id]);
    
    await pool.query(`
        UPDATE ${tenantSchema}.books 
        SET status = 'active'
        WHERE id = $1
    `, [bookId]);
    
    logger.info({ fractalId: bookRecord.fractal_id, bookId, phone: msg.phone }, 'Activated book');
    
    await pool.query(`
        INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
        VALUES ($1, $2, TRUE, NOW(), NOW())
        ON CONFLICT (book_registry_id, phone) DO UPDATE 
        SET last_engaged_at = NOW(), is_creator = TRUE
    `, [bookRecord.id, msg.phone]);
    
    if (hermesBot && hermesBot.isReady()) {
        try {
            const tenantIdMatch = tenantSchema.match(/tenant_(\d+)/);
            const tenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
            
            let userOutputUrl = null;
            if (bookRecord.outpipes_user) {
                try {
                    const outpipesUser = typeof bookRecord.outpipes_user === 'string' 
                        ? JSON.parse(bookRecord.outpipes_user) 
                        : bookRecord.outpipes_user;
                    if (Array.isArray(outpipesUser) && outpipesUser.length > 0) {
                        userOutputUrl = outpipesUser[0]?.url || null;
                    }
                } catch (e) {
                    logger.warn({ error: e.message }, 'Failed to parse outpipes_user');
                }
            }
            
            logger.info({ bookName: bookRecord.book_name, tenantId, bookId, hasUserOutput: !!userOutputUrl }, 'Hermes creating dual outputs');
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
            }, 'Hermes dual-thread setup complete');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to create Hermes threads');
        }
    }
    
    await channel.sendReply(msg.rawFrom, 
        `Book activated! Your messages will now be saved to "${bookRecord.book_name}". Send anything to test it out!`
    );
    
    return sendChannelResponse(res, channel);
}

async function handleActiveBook(res, channel, msg, rawPayload, bookRecord, deps) {
    const { pool, logger } = deps;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id }, 'Forwarding message to active book');
    
    const bookDetailsResult = await pool.query(`
        SELECT id, name, fractal_id, output_credentials 
        FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookDetailsResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Book not found in tenant schema');
        return sendChannelResponse(res, channel);
    }
    
    const book = bookDetailsResult.rows[0];
    
    try {
        await pool.query(`
            INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
            VALUES ($1, $2, FALSE, NOW(), NOW())
            ON CONFLICT (book_registry_id, phone) DO UPDATE 
            SET last_engaged_at = NOW()
        `, [bookRecord.id, msg.phone]);
        logger.info({ phone: msg.phone, fractalId: bookRecord.fractal_id }, 'Tracked engagement');
    } catch (error) {
        logger.error({ error: error.message }, 'Could not track engagement');
    }
    
    const outputCreds = book.output_credentials || {};
    const output01 = outputCreds.output_01;
    const webhooks = outputCreds.webhooks || [];
    
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
    
    const msgTimestamp = embed.timestamp;

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

    // Build ZK-ready capsule (sync, ~0ms — same data already in scope)
    const tenantIdMatch = bookRecord.tenant_schema?.match(/tenant_(\d+)/);
    const capsuleTenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
    const capsule = buildCapsule({
        bookFractalId: book.fractal_id,
        tenantId: capsuleTenantId,
        phone: msg.phone,
        body: msg.body,
        media,
        timestamp: msgTimestamp
    });

    if (output01?.type === 'thread' && output01?.thread_id) {
        try {
            const discordResponse = await sendToDiscordThread(output01.thread_id, { embeds: [embed] }, media, deps);
            logger.info({ threadId: output01.thread_id }, 'Sent to Ledger thread');
            // Fill discord_url on capsule attachment before async pin fires
            if (media && capsule.attachments.length > 0) {
                const cdnUrl = discordResponse?.data?.attachments?.[0]?.url;
                if (cdnUrl) capsule.attachments[0].discord_url = cdnUrl;
            }
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send to Ledger');
        }
    }
    
    for (const webhook of webhooks) {
        try {
            await sendToWebhook(webhook.url, { embeds: [embed] }, media);
            logger.info({ webhookName: webhook.name || 'Personal' }, 'Sent to webhook');
        } catch (error) {
            logger.error({ error: error.message, webhookName: webhook.name }, 'Failed to send to webhook');
        }
    }

    // ── Capsule pipeline (fire-and-forget — never blocks Discord write) ──────
    // Writes ledger row immediately (CIDs null), fills in async as pins resolve
    ;(async () => {
        try {
            if (pool) {
                await pool.query(
                    `INSERT INTO core.message_ledger
                     (message_fractal_id, book_fractal_id, sender_hash, content_hash,
                      has_attachment, attachment_disclosed)
                     VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT (message_fractal_id) DO NOTHING`,
                    [
                        capsule.message_fractal_id,
                        capsule.book_fractal_id,
                        capsule.sender_hash,
                        capsule.content_hash,
                        capsule.attachments.length > 0,
                        capsule.attachments[0]?.disclosed ?? true
                    ]
                );
            }
            // Pin capsule JSON → get CID
            const jsonResult = await pinJson(capsule);
            if (jsonResult?.cid && pool) {
                await pool.query(
                    `UPDATE core.message_ledger SET ipfs_cid = $1 WHERE message_fractal_id = $2`,
                    [jsonResult.cid, capsule.message_fractal_id]
                );
            }
            // Pin attachment binary (if present and disclosed)
            if (media?.buffer && capsule.attachments[0]?.disclosed) {
                const fileResult = await pinBuffer(media.buffer, media.contentType);
                if (fileResult?.cid) {
                    capsule.attachments[0].attachment_cid = fileResult.cid;
                    if (pool) {
                        await pool.query(
                            `UPDATE core.message_ledger SET attachment_cid = $1 WHERE message_fractal_id = $2`,
                            [fileResult.cid, capsule.message_fractal_id]
                        );
                    }
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

    return sendChannelResponse(res, channel);
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

    try {
        return await doSend();
    } catch (err) {
        const isArchived = err?.response?.status === 403 && err?.response?.data?.code === 50083;
        if (isArchived) {
            if (logger) logger.info({ threadId }, '🔓 Thread archived — unarchiving and retrying');
            else console.log(`🔓 Thread ${threadId} archived — unarchiving and retrying`);
            await axios.patch(
                `https://discord.com/api/v10/channels/${threadId}`,
                { archived: false, auto_archive_duration: 10080 },
                { headers: { 'Authorization': `Bot ${hermesToken}`, 'Content-Type': 'application/json' } }
            );
            return await doSend();
        } else {
            throw err;
        }
    }
}

async function sendToWebhook(webhookUrl, payload, media) {
    if (media) {
        const form = new FormData();
        form.append('files[0]', media.buffer, {
            filename: media.filename,
            contentType: media.contentType
        });
        form.append('payload_json', JSON.stringify(payload));
        
        await axios.post(webhookUrl, form, {
            headers: form.getHeaders()
        });
    } else {
        await axios.post(webhookUrl, payload);
    }
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
    
    await pool.query(`
        UPDATE core.book_registry 
        SET phone_number = $1, creator_phone = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
        WHERE id = $2
    `, [msg.phone, bookRecord.id]);
    
    await pool.query(`
        UPDATE ${tenantSchema}.books 
        SET status = 'active'
        WHERE id = $1
    `, [bookId]);
    
    logger.info({ fractalId: bookRecord.fractal_id, bookId, phone: msg.phone }, 'Async: Activated book');
    
    await pool.query(`
        INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
        VALUES ($1, $2, TRUE, NOW(), NOW())
        ON CONFLICT (book_registry_id, phone) DO UPDATE 
        SET last_engaged_at = NOW(), is_creator = TRUE
    `, [bookRecord.id, msg.phone]);
    
    if (hermesBot && hermesBot.isReady()) {
        try {
            const tenantIdMatch = tenantSchema.match(/tenant_(\d+)/);
            const tenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
            
            let userOutputUrl = null;
            if (bookRecord.outpipes_user) {
                try {
                    const outpipesUser = typeof bookRecord.outpipes_user === 'string' 
                        ? JSON.parse(bookRecord.outpipes_user) 
                        : bookRecord.outpipes_user;
                    if (Array.isArray(outpipesUser) && outpipesUser.length > 0) {
                        userOutputUrl = outpipesUser[0]?.url || null;
                    }
                } catch (e) {
                    logger.warn({ error: e.message }, 'Async: Failed to parse outpipes_user');
                }
            }
            
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
        SELECT id, name, fractal_id, output_credentials 
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
    const webhooks = outputCreds.webhooks || [];
    
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
    if (output01?.type === 'thread' && output01?.thread_id) {
        try {
            await sendToDiscordThread(output01.thread_id, { embeds: [embed] }, media, deps);
            logger.info({ threadId: output01.thread_id }, 'Async: Sent to Ledger thread');
        } catch (error) {
            logger.error({ error: error.message }, 'Async: Failed to send to Ledger');
        }
    }
    
    // FIRE to all webhooks (parallel, source of truth mirrors)
    const webhookPromises = webhooks.map(async (webhook) => {
        try {
            await sendToWebhook(webhook.url, { embeds: [embed] }, media);
            logger.info({ webhookName: webhook.name || 'Personal' }, 'Async: Sent to webhook');
        } catch (error) {
            logger.error({ error: error.message, webhookName: webhook.name }, 'Async: Failed to send to webhook');
        }
    });
    
    await Promise.allSettled(webhookPromises);
}

module.exports = { registerInpipeRoutes };
